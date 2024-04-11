const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const th = testHelpers.TestHelper
const { dec, toBN, assertRevert } = th
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

var contracts
var validCollateral
var snapshotId
var initialSnapshotId

const openVessel = async params => th.openVessel(contracts.core, params)
const deploy = async (treasury, mintingAccounts) => {
	contracts = await deploymentHelper.deployTestContracts(treasury, mintingAccounts)

	activePool = contracts.core.activePool
	adminContract = contracts.core.adminContract
	borrowerOperations = contracts.core.borrowerOperations
	collSurplusPool = contracts.core.collSurplusPool
	debtToken = contracts.core.debtToken
	defaultPool = contracts.core.defaultPool
	erc20 = contracts.core.erc20
	erc20B = contracts.core.erc20B
	feeCollector = contracts.core.feeCollector
	gasPool = contracts.core.gasPool
	priceFeed = contracts.core.priceFeedTestnet
	sortedVessels = contracts.core.sortedVessels
	stabilityPool = contracts.core.stabilityPool
	vesselManager = contracts.core.vesselManager
	vesselManagerOperations = contracts.core.vesselManagerOperations
	shortTimelock = contracts.core.shortTimelock
	longTimelock = contracts.core.longTimelock

	validCollateral = await adminContract.getValidCollateral()

	// getDepositorGains() expects a sorted collateral array
	validCollateral = validCollateral.slice(0).sort((a, b) => toBN(a.toLowerCase()).sub(toBN(b.toLowerCase())))
}

contract("StabilityPool", async accounts => {
	const [
		owner,
		defaulter_1,
		defaulter_2,
		defaulter_3,
		defaulter_4,
		defaulter_5,
		defaulter_6,
		whale,
		alice,
		bob,
		carol,
		dennis,
		erin,
		flyn,
		graham,
		treasury,
	] = accounts

	const getOpenVesselTRIAmount = async (totalDebt, asset) =>
		th.getOpenVesselTRIAmount(contracts.core, totalDebt, asset)

	async function _openVessel(erc20Contract, extraDebtTokenAmt, sender) {
		await _openVesselWithICR(erc20Contract, extraDebtTokenAmt, 2, sender)
	}

	async function _openVesselWithICR(erc20Contract, extraDebtTokenAmt, icr, sender) {
		await th.openVessel(contracts.core, {
			asset: erc20Contract.address,
			extraTRIAmount: toBN(dec(extraDebtTokenAmt, 18)),
			ICR: toBN(dec(icr, 18)),
			extraParams: { from: sender },
		})
	}

	async function _openVesselWithCollAmt(erc20Contract, collAmt, extraDebtTokenAmt, sender) {
		await th.openVessel(contracts.core, {
			asset: erc20Contract.address,
			assetSent: toBN(dec(collAmt, 18)),
			extraTRIAmount: toBN(dec(extraDebtTokenAmt, 18)),
			//ICR: toBN(dec(2, 18)),
			extraParams: { from: sender },
		})
	}

	async function openWhaleVessel(erc20Contract, icr = 2, extraDebtTokenAmt = 100_000) {
		await openVessel({
			asset: erc20Contract.address,
			assetSent: toBN(dec(50, 18)),
			extraTRIAmount: toBN(dec(extraDebtTokenAmt, 18)),
			ICR: toBN(dec(icr, 18)),
			extraParams: { from: whale },
		})
	}

	async function dropPriceByPercent(erc20Contract, pct) {
		const price = await priceFeed.getPrice(erc20Contract.address)
		const newPrice = price.mul(toBN(100 - pct)).div(toBN(100))
		await priceFeed.setPrice(erc20Contract.address, newPrice)
	}

	describe("Stability Pool Mechanisms", async () => {
		before(async () => {
			await deploy(treasury, accounts.slice(0, 20))
			initialSnapshotId = await network.provider.send("evm_snapshot")
		})

		beforeEach(async () => {
			snapshotId = await network.provider.send("evm_snapshot")
		})

		afterEach(async () => {
			await network.provider.send("evm_revert", [snapshotId])
		})

		after(async () => {
			await network.provider.send("evm_revert", [initialSnapshotId])
		})

		describe("Providing", async () => {
			it("provideToSP(): increases the Stability Pool balance", async () => {
				await _openVessel(erc20, (extraDebtTokenAmt = 200), alice)
				await stabilityPool.provideToSP(200, validCollateral, { from: alice })
				assert.equal(await stabilityPool.getTotalDebtTokenDeposits(), 200)
			})

			it("provideToSP(): reverts when trying to make a SP deposit without debt token balance", async () => {
				const aliceTxPromise = stabilityPool.provideToSP(200, validCollateral, { from: alice })
				await assertRevert(aliceTxPromise, "revert")
			})

			it("provideToSP(): updates the user's deposit record in StabilityPool", async () => {
				await _openVessel(erc20, (extraDebtTokenAmt = 200), alice)
				assert.equal(await stabilityPool.deposits(alice), 0)
				await stabilityPool.provideToSP(200, validCollateral, { from: alice })
				assert.equal(await stabilityPool.deposits(alice), 200)
			})

			it("provideToSP(): reduces the user's debt token balance by the correct amount", async () => {
				await _openVessel(erc20, (extraDebtTokenAmt = 200), alice)
				const alice_balance_Before = await debtToken.balanceOf(alice)
				await stabilityPool.provideToSP(400, validCollateral, { from: alice })
				const alice_balance_After = await debtToken.balanceOf(alice)
				assert.equal(alice_balance_Before.sub(alice_balance_After), "400")
			})

			it("provideToSP(): reverts if user tries to provide more than their debt token balance", async () => {
				await _openVessel(erc20, 10_000, alice)
				await _openVessel(erc20, 10_000, bob)

				const aliceBal = await debtToken.balanceOf(alice)
				const bobBal = await debtToken.balanceOf(bob)

				// Alice attempts to deposit 1 wei more than her balance
				const aliceTxPromise = stabilityPool.provideToSP(aliceBal.add(toBN(1)), validCollateral, { from: alice })
				await assertRevert(aliceTxPromise, "revert")

				// Bob attempts to deposit 235534 more than his balance
				const bobTxPromise = stabilityPool.provideToSP(bobBal.add(toBN(dec(235534, 18))), validCollateral, {
					from: bob,
				})
				await assertRevert(bobTxPromise, "revert")
			})

			it("provideToSP(): reverts if user tries to provide 2^256-1 debt tokens, which exceeds their balance", async () => {
				await _openVessel(erc20, 10_000, alice)
				const maxBytes32 = web3.utils.toBN("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
				// Alice attempts to deposit 2^256-1
				try {
					aliceTx = await stabilityPool.provideToSP(maxBytes32, validCollateral, { from: alice })
					assert.isFalse(aliceTx.receipt.status)
				} catch (error) {
					assert.include(error.message, "revert")
				}
			})

			it("provideToSP(): doesn't impact any vessels, including the caller's vessel", async () => {
				await openWhaleVessel(erc20)

				// A, B, C open vessels and make Stability Pool deposits
				await _openVessel(erc20, 1_000, alice)
				await _openVessel(erc20, 2_000, bob)
				await _openVessel(erc20, 3_000, carol)

				// A and B provide to SP
				await stabilityPool.provideToSP(dec(1_000, 18), validCollateral, { from: alice })
				await stabilityPool.provideToSP(dec(2_000, 18), validCollateral, { from: bob })

				// D opens a vessel
				await _openVessel(erc20, 1_000, dennis)

				// Price drops
				await priceFeed.setPrice(erc20.address, dec(105, 18))
				const price = await priceFeed.getPrice(erc20.address)

				// Get debt, collateral and ICR of all existing vessels
				const whale_Debt_BeforeERC20 = (await vesselManager.Vessels(whale, erc20.address))[0].toString()
				const alice_Debt_BeforeERC20 = (await vesselManager.Vessels(alice, erc20.address))[0].toString()
				const bob_Debt_BeforeERC20 = (await vesselManager.Vessels(bob, erc20.address))[0].toString()
				const carol_Debt_BeforeERC20 = (await vesselManager.Vessels(carol, erc20.address))[0].toString()
				const dennis_Debt_BeforeERC20 = (await vesselManager.Vessels(dennis, erc20.address))[0].toString()

				const whale_Coll_BeforeERC20 = (await vesselManager.Vessels(whale, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const alice_Coll_BeforeERC20 = (await vesselManager.Vessels(alice, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const bob_Coll_BeforeERC20 = (await vesselManager.Vessels(bob, erc20.address))[th.VESSEL_COLL_INDEX].toString()
				const carol_Coll_BeforeERC20 = (await vesselManager.Vessels(carol, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const dennis_Coll_BeforeERC20 = (await vesselManager.Vessels(dennis, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()

				const whale_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, whale, price)).toString()
				const alice_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, alice, price)).toString()
				const bob_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, bob, price)).toString()
				const carol_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, carol, price)).toString()
				const dennis_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, dennis, price)).toString()

				// D makes an SP deposit
				await stabilityPool.provideToSP(dec(1000, 18), validCollateral, { from: dennis })
				assert.equal((await stabilityPool.getCompoundedDebtTokenDeposits(dennis)).toString(), dec(1000, 18))

				const whale_Debt_AfterERC20 = (await vesselManager.Vessels(whale, erc20.address))[0].toString()
				const alice_Debt_AfterERC20 = (await vesselManager.Vessels(alice, erc20.address))[0].toString()
				const bob_Debt_AfterERC20 = (await vesselManager.Vessels(bob, erc20.address))[0].toString()
				const carol_Debt_AfterERC20 = (await vesselManager.Vessels(carol, erc20.address))[0].toString()
				const dennis_Debt_AfterERC20 = (await vesselManager.Vessels(dennis, erc20.address))[0].toString()

				const whale_Coll_AfterERC20 = (await vesselManager.Vessels(whale, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const alice_Coll_AfterERC20 = (await vesselManager.Vessels(alice, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const bob_Coll_AfterERC20 = (await vesselManager.Vessels(bob, erc20.address))[th.VESSEL_COLL_INDEX].toString()
				const carol_Coll_AfterERC20 = (await vesselManager.Vessels(carol, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const dennis_Coll_AfterERC20 = (await vesselManager.Vessels(dennis, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()

				const whale_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, whale, price)).toString()
				const alice_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, alice, price)).toString()
				const bob_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, bob, price)).toString()
				const carol_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, carol, price)).toString()
				const dennis_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, dennis, price)).toString()

				assert.equal(whale_Debt_BeforeERC20, whale_Debt_AfterERC20)
				assert.equal(alice_Debt_BeforeERC20, alice_Debt_AfterERC20)
				assert.equal(bob_Debt_BeforeERC20, bob_Debt_AfterERC20)
				assert.equal(carol_Debt_BeforeERC20, carol_Debt_AfterERC20)
				assert.equal(dennis_Debt_BeforeERC20, dennis_Debt_AfterERC20)

				assert.equal(whale_Coll_BeforeERC20, whale_Coll_AfterERC20)
				assert.equal(alice_Coll_BeforeERC20, alice_Coll_AfterERC20)
				assert.equal(bob_Coll_BeforeERC20, bob_Coll_AfterERC20)
				assert.equal(carol_Coll_BeforeERC20, carol_Coll_AfterERC20)
				assert.equal(dennis_Coll_BeforeERC20, dennis_Coll_AfterERC20)

				assert.equal(whale_ICR_BeforeERC20, whale_ICR_AfterERC20)
				assert.equal(alice_ICR_BeforeERC20, alice_ICR_AfterERC20)
				assert.equal(bob_ICR_BeforeERC20, bob_ICR_AfterERC20)
				assert.equal(carol_ICR_BeforeERC20, carol_ICR_AfterERC20)
				assert.equal(dennis_ICR_BeforeERC20, dennis_ICR_AfterERC20)
			})

			it("provideToSP(): providing 0 reverts", async () => {
				// A, B, C open vessels and make Stability Pool deposits
				await _openVessel(erc20, 1_000, alice)
				await _openVessel(erc20, 2_000, bob)
				await _openVessel(erc20, 3_000, carol)

				// A, B, C provide 100, 50, 30 to SP
				await stabilityPool.provideToSP(dec(100, 18), validCollateral, { from: alice })
				await stabilityPool.provideToSP(dec(50, 18), validCollateral, { from: bob })
				await stabilityPool.provideToSP(dec(30, 18), validCollateral, { from: carol })

				const poolBalance = (await stabilityPool.getTotalDebtTokenDeposits()).toString()
				assert.equal(poolBalance, dec(180, 18))

				// Bob attempts to provide 0
				const txPromise_B = stabilityPool.provideToSP(0, validCollateral, { from: bob })
				await th.assertRevert(txPromise_B)
			})

			it("provideToSP(): new deposit = depositor does not receive gains", async () => {
				await openWhaleVessel(erc20)

				// Whale transfers debt tokens to A, B
				await debtToken.transfer(alice, dec(200, 18), { from: whale })
				await debtToken.transfer(bob, dec(400, 18), { from: whale })

				// C, D open vessels
				await _openVessel(erc20, 1_000, carol)
				await _openVessel(erc20, 2_000, dennis)

				const A_Balance_BeforeERC20 = await erc20.balanceOf(alice)
				const B_Balance_BeforeERC20 = await erc20.balanceOf(bob)
				const C_Balance_BeforeERC20 = await erc20.balanceOf(carol)
				const D_Balance_BeforeERC20 = await erc20.balanceOf(dennis)

				// A, B, C, D provide to SP
				await stabilityPool.provideToSP(dec(100, 18), validCollateral, { from: alice })
				await stabilityPool.provideToSP(dec(200, 18), validCollateral, { from: bob })
				await stabilityPool.provideToSP(dec(300, 18), validCollateral, { from: carol })
				await stabilityPool.provideToSP(dec(400, 18), validCollateral, { from: dennis })

				const A_ETHBalance_AfterERC20 = await erc20.balanceOf(alice)
				const B_ETHBalance_AfterERC20 = await erc20.balanceOf(bob)
				const C_ETHBalance_AfterERC20 = await erc20.balanceOf(carol)
				const D_ETHBalance_AfterERC20 = await erc20.balanceOf(dennis)

				// Check balances have not changed
				assert.equal(A_ETHBalance_AfterERC20, A_Balance_BeforeERC20.toString())
				assert.equal(B_ETHBalance_AfterERC20, B_Balance_BeforeERC20.toString())
				assert.equal(C_ETHBalance_AfterERC20, C_Balance_BeforeERC20.toString())
				assert.equal(D_ETHBalance_AfterERC20, D_Balance_BeforeERC20.toString())
			})

			it("provideToSP(): passing same asset twice will revert", async () => {
				await openWhaleVessel(erc20, (icr = 10), (extraDebtTokenAmt = 1_000_000))
				// first call won't revert as there is no initial deposit
				await stabilityPool.provideToSP(dec(199_000, 18), [erc20.address, erc20.address], { from: whale })
				// second call should revert
				const txPromise = stabilityPool.provideToSP(dec(1_000, 18), [erc20.address, erc20B.address, erc20.address], {
					from: whale,
				})
				await assertRevert(txPromise, "StabilityPool__ArrayNotInAscendingOrder")
			})

			it("provideToSP(): passing asset array in non-ascending order will revert", async () => {
				await openWhaleVessel(erc20, (icr = 10), (extraDebtTokenAmt = 1_000_000))
				// correct order
				await stabilityPool.provideToSP(dec(199_000, 18), validCollateral, { from: whale })
				// incorrect order - should revert
				const validCollateralReverse = validCollateral.slice(0).reverse()
				const txPromise = stabilityPool.provideToSP(dec(1_000, 18), validCollateralReverse, {
					from: whale,
				})
				await assertRevert(txPromise, "StabilityPool__ArrayNotInAscendingOrder")
			})

			it("provideToSP(): passing wrong address to asset list has no impact", async () => {
				await openWhaleVessel(erc20, (icr = 10), (extraDebtTokenAmt = 1_000_000))
				// first call won't revert as there is no initial deposit
				await stabilityPool.provideToSP(dec(199_000, 18), [alice], { from: whale })
				await stabilityPool.provideToSP(dec(1_000, 18), [alice], { from: whale })
				await stabilityPool.withdrawFromSP(dec(1_000, 18), [alice], { from: whale })
			})

			it("provideToSP(): reverts when amount is zero", async () => {
				await openWhaleVessel(erc20, (icr = 10))

				await _openVessel(erc20, 1_000, alice)
				await _openVessel(erc20, 2_000, bob)

				await debtToken.transfer(carol, dec(200, 18), { from: whale })
				await debtToken.transfer(dennis, dec(200, 18), { from: whale })

				txPromise_A = stabilityPool.provideToSP(0, validCollateral, { from: alice })
				txPromise_B = stabilityPool.provideToSP(0, validCollateral, { from: bob })
				txPromise_C = stabilityPool.provideToSP(0, validCollateral, { from: carol })
				txPromise_D = stabilityPool.provideToSP(0, validCollateral, { from: dennis })

				await th.assertRevert(txPromise_A, "StabilityPool: Amount must be non-zero")
				await th.assertRevert(txPromise_B, "StabilityPool: Amount must be non-zero")
				await th.assertRevert(txPromise_C, "StabilityPool: Amount must be non-zero")
				await th.assertRevert(txPromise_D, "StabilityPool: Amount must be non-zero")
			})
		})

		describe("Withdrawing", async () => {
			it("withdrawFromSP(): reverts when user has no active deposit", async () => {
				await _openVessel(erc20, 100, alice)
				await _openVessel(erc20, 100, bob)

				await stabilityPool.provideToSP(dec(100, 18), validCollateral, { from: alice })

				const alice_initialDeposit = (await stabilityPool.deposits(alice)).toString()
				const bob_initialDeposit = (await stabilityPool.deposits(bob)).toString()

				assert.equal(alice_initialDeposit, dec(100, 18))
				assert.equal(bob_initialDeposit, "0")

				try {
					const txBob = await stabilityPool.withdrawFromSP(dec(100, 18), validCollateral, { from: bob })
					assert.isFalse(txBob.receipt.status)
				} catch (err) {
					assert.include(err.message, "revert")
				}
			})

			it("withdrawFromSP(): withdraw from SP, passing same asset twice will revert", async () => {
				await openWhaleVessel(erc20, (icr = 10), (extraDebtTokenAmt = 1_000_000))
				await stabilityPool.provideToSP(dec(199_000, 18), validCollateral, { from: whale })
				const txPromise = stabilityPool.withdrawFromSP(dec(1000, 18), [erc20.address, erc20.address], { from: whale })
				await assertRevert(txPromise, "StabilityPool__DuplicateElementOnArray")
			})

			it("withdrawFromSP(): doesn't impact any vessels, including the caller's vessel", async () => {
				await openWhaleVessel(erc20, (icr = 10))

				// A, B, C open vessels and make Stability Pool deposits
				await _openVessel(erc20, 10_000, alice)
				await _openVessel(erc20, 20_000, bob)
				await _openVessel(erc20, 30_000, carol)

				// A, B and C provide to SP
				await stabilityPool.provideToSP(dec(10_000, 18), validCollateral, { from: alice })
				await stabilityPool.provideToSP(dec(20_000, 18), validCollateral, { from: bob })
				await stabilityPool.provideToSP(dec(30_000, 18), validCollateral, { from: carol })

				// Price drops
				await priceFeed.setPrice(erc20.address, dec(105, 18))
				const price = await priceFeed.getPrice(erc20.address)

				// Get debt, collateral and ICR of all existing vessels
				const whale_Debt_BeforeERC20 = (await vesselManager.Vessels(whale, erc20.address))[0].toString()
				const alice_Debt_BeforeERC20 = (await vesselManager.Vessels(alice, erc20.address))[0].toString()
				const bob_Debt_BeforeERC20 = (await vesselManager.Vessels(bob, erc20.address))[0].toString()
				const carol_Debt_BeforeERC20 = (await vesselManager.Vessels(carol, erc20.address))[0].toString()

				const whale_Coll_BeforeERC20 = (await vesselManager.Vessels(whale, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const alice_Coll_BeforeERC20 = (await vesselManager.Vessels(alice, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const bob_Coll_BeforeERC20 = (await vesselManager.Vessels(bob, erc20.address))[th.VESSEL_COLL_INDEX].toString()
				const carol_Coll_BeforeERC20 = (await vesselManager.Vessels(carol, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()

				const whale_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, whale, price)).toString()
				const alice_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, alice, price)).toString()
				const bob_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, bob, price)).toString()
				const carol_ICR_BeforeERC20 = (await vesselManager.getCurrentICR(erc20.address, carol, price)).toString()

				// Price rises
				await priceFeed.setPrice(erc20.address, dec(200, 18))

				// Carol withdraws her Stability deposit
				assert.equal((await stabilityPool.deposits(carol)).toString(), dec(30000, 18))
				await stabilityPool.withdrawFromSP(dec(30000, 18), validCollateral, { from: carol })
				assert.equal((await stabilityPool.deposits(carol)).toString(), "0")

				const whale_Debt_AfterERC20 = (await vesselManager.Vessels(whale, erc20.address))[0].toString()
				const alice_Debt_AfterERC20 = (await vesselManager.Vessels(alice, erc20.address))[0].toString()
				const bob_Debt_AfterERC20 = (await vesselManager.Vessels(bob, erc20.address))[0].toString()
				const carol_Debt_AfterERC20 = (await vesselManager.Vessels(carol, erc20.address))[0].toString()

				const whale_Coll_AfterERC20 = (await vesselManager.Vessels(whale, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const alice_Coll_AfterERC20 = (await vesselManager.Vessels(alice, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()
				const bob_Coll_AfterERC20 = (await vesselManager.Vessels(bob, erc20.address))[th.VESSEL_COLL_INDEX].toString()
				const carol_Coll_AfterERC20 = (await vesselManager.Vessels(carol, erc20.address))[
					th.VESSEL_COLL_INDEX
				].toString()

				const whale_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, whale, price)).toString()
				const alice_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, alice, price)).toString()
				const bob_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, bob, price)).toString()
				const carol_ICR_AfterERC20 = (await vesselManager.getCurrentICR(erc20.address, carol, price)).toString()

				// Check all vessels are unaffected by Carol's Stability deposit withdrawal
				assert.equal(whale_Debt_BeforeERC20, whale_Debt_AfterERC20)
				assert.equal(alice_Debt_BeforeERC20, alice_Debt_AfterERC20)
				assert.equal(bob_Debt_BeforeERC20, bob_Debt_AfterERC20)
				assert.equal(carol_Debt_BeforeERC20, carol_Debt_AfterERC20)

				assert.equal(whale_Coll_BeforeERC20, whale_Coll_AfterERC20)
				assert.equal(alice_Coll_BeforeERC20, alice_Coll_AfterERC20)
				assert.equal(bob_Coll_BeforeERC20, bob_Coll_AfterERC20)
				assert.equal(carol_Coll_BeforeERC20, carol_Coll_AfterERC20)

				assert.equal(whale_ICR_BeforeERC20, whale_ICR_AfterERC20)
				assert.equal(alice_ICR_BeforeERC20, alice_ICR_AfterERC20)
				assert.equal(bob_ICR_BeforeERC20, bob_ICR_AfterERC20)
				assert.equal(carol_ICR_BeforeERC20, carol_ICR_AfterERC20)
			})

			it("withdrawFromSP(): withdrawing 0 TRI doesn't alter the caller's deposit or the total TRI in the Stability Pool", async () => {
				// --- SETUP ---
				await openWhaleVessel(erc20, (icr = 10))

				// A, B, C open vessels and make Stability Pool deposits
				await openVessel({
					asset: erc20.address,
					extraTRIAmount: toBN(dec(10000, 18)),
					ICR: toBN(dec(2, 18)),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					extraTRIAmount: toBN(dec(20000, 18)),
					ICR: toBN(dec(2, 18)),
					extraParams: { from: bob },
				})
				await openVessel({
					asset: erc20.address,
					extraTRIAmount: toBN(dec(30000, 18)),
					ICR: toBN(dec(2, 18)),
					extraParams: { from: carol },
				})

				// A, B, C provides 100, 50, 30 TRI to SP
				await stabilityPool.provideToSP(dec(100, 18), validCollateral, { from: alice })
				await stabilityPool.provideToSP(dec(50, 18), validCollateral, { from: bob })
				await stabilityPool.provideToSP(dec(30, 18), validCollateral, { from: carol })

				const bob_Deposit_Before = (await stabilityPool.getCompoundedDebtTokenDeposits(bob)).toString()
				const TRIinSP_Before = (await stabilityPool.getTotalDebtTokenDeposits()).toString()

				assert.equal(TRIinSP_Before, dec(180, 18))

				// Bob withdraws 0 TRI from the Stability Pool
				await stabilityPool.withdrawFromSP(0, validCollateral, { from: bob })

				// check Bob's deposit and total TRI in Stability Pool has not changed
				const bob_Deposit_After = (await stabilityPool.getCompoundedDebtTokenDeposits(bob)).toString()
				const TRIinSP_After = (await stabilityPool.getTotalDebtTokenDeposits()).toString()

				assert.equal(bob_Deposit_Before, bob_Deposit_After)
				assert.equal(TRIinSP_Before, TRIinSP_After)
			})
		})

	})
})

contract("Reset chain state", async accounts => {})


const {
	time,
	setBalance,
	impersonateAccount,
	stopImpersonatingAccount,
} = require("@nomicfoundation/hardhat-network-helpers")
const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const th = testHelpers.TestHelper
const { dec, toBN, assertRevert } = th
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const { ethers } = require("hardhat")
const f = v => ethers.utils.formatEther(v.toString())

var contracts
var snapshotId
var initialSnapshotId
var validCollateral

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

/* NOTE: Some tests involving ETH redemption fees do not test for specific fee values.
 * Some only test that the fees are non-zero when they should occur.
 *
 * Specific ETH gain values will depend on the final fee schedule used, and the final choices for
 * the parameter BETA in the VesselManager, which is still TBD based on economic modelling.
 *
 */
contract("VesselManager", async accounts => {
	const _18_zeros = "000000000000000000"
	const ZERO_ADDRESS = th.ZERO_ADDRESS

	const [
		owner,
		alice,
		bob,
		carol,
		dennis,
		erin,
		flyn,
		graham,
		harriet,
		ida,
		defaulter_1,
		defaulter_2,
		defaulter_3,
		defaulter_4,
		whale,
		A,
		B,
		C,
		D,
		E,
		treasury,
	] = accounts

	const multisig = accounts[999]

	let REDEMPTION_SOFTENING_PARAM
	const getOpenVesselTRIAmount = async (totalDebt, asset) =>
		th.getOpenVesselTRIAmount(contracts.core, totalDebt, asset)
	const getNetBorrowingAmount = async (debtWithFee, asset) =>
		th.getNetBorrowingAmount(contracts.core, debtWithFee, asset)
	const openVessel = async params => th.openVessel(contracts.core, params)
	const withdrawTRI = async params => th.withdrawTRI(contracts.core, params)
	const calcSoftnedAmount = (collAmount, price) =>
		collAmount.mul(mv._1e18BN).mul(REDEMPTION_SOFTENING_PARAM).div(toBN(10000)).div(price)

	describe("Vessel Manager", async () => {
		before(async () => {
			await deploy(treasury, accounts.slice(0, 20))

			// give some gas to the contracts that will be impersonated
			setBalance(adminContract.address, 1e18)
			setBalance(shortTimelock.address, 1e18)
			for (const acc of accounts.slice(0, 20)) {
				await erc20.mint(acc, await web3.eth.getBalance(acc))
			}

			await impersonateAccount(shortTimelock.address)
			await vesselManagerOperations.setRedemptionSofteningParam("9700", { from: shortTimelock.address })
			await stopImpersonatingAccount(shortTimelock.address)
			REDEMPTION_SOFTENING_PARAM = await vesselManagerOperations.redemptionSofteningParam()

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

		// --- redemptions ---

		describe("Redemptions", async () => {
			it("getRedemptionHints(): gets the address of the first Vessel and the final ICR of the last Vessel involved in a redemption", async () => {
				// --- SETUP ---
				const partialRedemptionAmount = toBN(dec(100, 18))
				const { collateral: A_coll, totalDebt: A_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(310, 16)),
					extraTRIAmount: partialRedemptionAmount,
					extraParams: { from: alice },
				})
				const { netDebt: B_debt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraParams: { from: bob },
				})
				const { netDebt: C_debt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(250, 16)),
					extraParams: { from: carol },
				})

				// Dennis' Vessel should be untouched by redemption, because its ICR will be < 110% after the price drop
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(120, 16)),
					extraParams: { from: dennis },
				})

				// Drop the price
				const price = toBN(dec(100, 18))
				await priceFeed.setPrice(erc20.address, price)

				// --- TEST ---
				const redemptionAmount = C_debt.add(B_debt).add(partialRedemptionAmount)

				const { 0: firstRedemptionHint, 1: partialRedemptionHintNewICR } =
					await vesselManagerOperations.getRedemptionHints(erc20.address, redemptionAmount, price, 0)

				assert.equal(firstRedemptionHint, carol)
				const expectedICR = A_coll.mul(price)
					.sub(partialRedemptionAmount.mul(mv._1e18BN))
					.div(A_totalDebt.sub(partialRedemptionAmount))
				const errorMargin = toBN(firstRedemptionHint).div(toBN(100)) // allow for a 1% error margin
				th.assertIsApproximatelyEqual(partialRedemptionHintNewICR, expectedICR, Number(errorMargin))
			})

			it("getRedemptionHints(): returns 0 as partialRedemptionHintNICR_Asset when reaching _maxIterations", async () => {
				// --- SETUP ---
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(310, 16)),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraParams: { from: bob },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(250, 16)),
					extraParams: { from: carol },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraParams: { from: dennis },
				})

				const price = await priceFeed.getPrice(erc20.address)

				// --- TEST ---

				// Get hints for a redemption of 170 + 30 + some extra TRI. At least 3 iterations are needed
				// for total redemption of the given amount.

				const { 1: partialRedemptionHintNICR_Asset } = await vesselManagerOperations.getRedemptionHints(
					erc20.address,
					"210" + _18_zeros,
					price,
					2
				) // limit _maxIterations to 2

				assert.equal(partialRedemptionHintNICR_Asset, "0")
			}),
				it("redemptionSofteningParam(): revert on invalid value", async () => {
					await impersonateAccount(shortTimelock.address)
					let tx = vesselManagerOperations.setRedemptionSofteningParam("10100", { from: shortTimelock.address })
					await th.assertRevert(tx)
					let tx2 = vesselManagerOperations.setRedemptionSofteningParam("9600", { from: shortTimelock.address })
					await th.assertRevert(tx2)
					await stopImpersonatingAccount(shortTimelock.address)
				}),
				it("redeemCollateral(): soft redemption dates", async () => {
					const redemptionWait = 14 * 24 * 60 * 60 // 14 days
					const redemptionBlock = (await time.latest()) + redemptionWait
					// turn off redemptions for 2 weeks
					await adminContract.setRedemptionBlockTimestamp(erc20.address, redemptionBlock)

					const { netDebt: aliceDebt } = await openVessel({
						asset: erc20.address,
						ICR: toBN(dec(290, 16)),
						extraTRIAmount: dec(8, 18),
						extraParams: { from: alice },
					})
					const { netDebt: bobDebt } = await openVessel({
						asset: erc20.address,
						ICR: toBN(dec(250, 16)),
						extraTRIAmount: dec(10, 18),
						extraParams: { from: bob },
					})
					const redemptionAmount = aliceDebt.add(bobDebt)

					await openVessel({
						asset: erc20.address,
						ICR: toBN(dec(100, 18)),
						extraTRIAmount: redemptionAmount,
						extraParams: { from: dennis },
					})

					const price = await priceFeed.getPrice(erc20.address)

					const { 1: hintNICR } = await vesselManagerOperations.getRedemptionHints(
						erc20.address,
						redemptionAmount,
						price,
						0
					)
					const { 0: upperHint, 1: lowerHint } = await sortedVessels.findInsertPosition(
						erc20.address,
						hintNICR,
						dennis,
						dennis
					)

					// expect tx before the redemption block to revert
					const tx = vesselManagerOperations.redeemCollateral(
						erc20.address,
						redemptionAmount,
						ZERO_ADDRESS,
						upperHint,
						lowerHint,
						hintNICR,
						0,
						th._100pct,
						{ from: dennis }
					)
					await th.assertRevert(tx)

					// skip redemption
					await time.increase(redemptionWait)

					await adminContract.setWhitelistedRedeemer(dennis, true)
					// this time tx should succeed
					await vesselManagerOperations.redeemCollateral(
						erc20.address,
						redemptionAmount,
						ZERO_ADDRESS,
						upperHint,
						lowerHint,
						hintNICR,
						0,
						th._100pct,
						{ from: dennis }
					)
				})

			it("redeemCollateral(): cancels the provided debtTokens with debt from Vessels with the lowest ICRs and sends an equivalent amount of collateral", async () => {
				const { totalDebt: A_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(310, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: alice },
				})
				const { netDebt: B_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraTRIAmount: dec(8, 18),
					extraParams: { from: bob },
				})
				const { netDebt: C_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(250, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: carol },
				})

				const partialRedemptionAmount = toBN(2)
				const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)

				// start Dennis with a high ICR
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(100, 18)),
					extraTRIAmount: redemptionAmount,
					extraParams: { from: dennis },
				})

				const dennis_CollBalance_Before = toBN(await erc20.balanceOf(dennis))
				const dennis_DebtTokenBalance_Before = await debtToken.balanceOf(dennis)

				const price = await priceFeed.getPrice(erc20.address)

				const { 0: firstRedemptionHint, 1: partialRedemptionHintNewICR } =
					await vesselManagerOperations.getRedemptionHints(erc20.address, redemptionAmount, price, 0)

				// We don't need to use getApproxHint for this test, since it's not the subject of this
				// test case, and the list is very small, so the correct position is quickly found
				const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedVessels.findInsertPosition(
					erc20.address,
					partialRedemptionHintNewICR,
					dennis,
					dennis
				)

				// skip redemption bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// Dennis redeems 20 debt tokens
				// Don't pay for gas, as it makes it easier to calculate the received collateral

				await adminContract.setWhitelistedRedeemer(dennis, true)
				const redemptionTx = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					redemptionAmount,
					firstRedemptionHint,
					upperPartialRedemptionHint,
					lowerPartialRedemptionHint,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: dennis }
				)

				const collFee = th.getEmittedRedemptionValues(redemptionTx)[3]

				const alice_Vessel_After = await vesselManager.Vessels(alice, erc20.address)
				const bob_Vessel_After = await vesselManager.Vessels(bob, erc20.address)
				const carol_Vessel_After = await vesselManager.Vessels(carol, erc20.address)

				const alice_debt_After = alice_Vessel_After[th.VESSEL_DEBT_INDEX].toString()
				const bob_debt_After = bob_Vessel_After[th.VESSEL_DEBT_INDEX].toString()
				const carol_debt_After = carol_Vessel_After[th.VESSEL_DEBT_INDEX].toString()

				// check that Dennis' redeemed 20 debt tokens have been cancelled with debt from Bobs's Vessel (8) and Carol's Vessel (10).
				// The remaining lot (2) is sent to Alice's Vessel, who had the best ICR.
				// It leaves her with (3) debt tokens + 50 for gas compensation.
				th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
				assert.equal(bob_debt_After, "0")
				assert.equal(carol_debt_After, "0")

				const dennis_CollBalance_After = toBN(await erc20.balanceOf(dennis))
				const receivedColl = dennis_CollBalance_After.sub(dennis_CollBalance_Before)

				const expectedTotalCollDrawn = calcSoftnedAmount(redemptionAmount, price)
				const expectedReceivedColl = expectedTotalCollDrawn.sub(toBN(collFee))

				th.assertIsApproximatelyEqual(expectedReceivedColl, receivedColl)

				const dennis_DebtTokenBalance_After = (await debtToken.balanceOf(dennis)).toString()
				th.assertIsApproximatelyEqual(
					dennis_DebtTokenBalance_After,
					dennis_DebtTokenBalance_Before.sub(redemptionAmount)
				)
			})

			it("redeemCollateral(): with invalid first hint, zero address", async () => {
				const { totalDebt: A_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(310, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: alice },
				})
				const { netDebt: B_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraTRIAmount: dec(8, 18),
					extraParams: { from: bob },
				})
				const { netDebt: C_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(250, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: carol },
				})

				const partialRedemptionAmount = toBN(2)
				const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)

				// start Dennis with a high ICR
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(100, 18)),
					extraTRIAmount: redemptionAmount,
					extraParams: { from: dennis },
				})

				const dennis_CollBalance_Before = toBN(await erc20.balanceOf(dennis))
				const dennis_DebtTokenBalance_Before = await debtToken.balanceOf(dennis)

				const price = await priceFeed.getPrice(erc20.address)

				// Find hints for redeeming 20 debt tokens
				const { 1: partialRedemptionHintNewICR } = await vesselManagerOperations.getRedemptionHints(
					erc20.address,
					redemptionAmount,
					price,
					0
				)

				// We don't need to use getApproxHint for this test, since it's not the subject of this
				// test case, and the list is very small, so the correct position is quickly found
				const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedVessels.findInsertPosition(
					erc20.address,
					partialRedemptionHintNewICR,
					dennis,
					dennis
				)

				// skip redemption bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await adminContract.setWhitelistedRedeemer(dennis, true)
				// Dennis redeems 20 debt tokens
				const redemptionTx = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					redemptionAmount,
					ZERO_ADDRESS, // invalid first hint
					upperPartialRedemptionHint,
					lowerPartialRedemptionHint,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: dennis }
				)

				const collFee = th.getEmittedRedemptionValues(redemptionTx)[3]

				const alice_Vessel_After = await vesselManager.Vessels(alice, erc20.address)
				const bob_Vessel_After = await vesselManager.Vessels(bob, erc20.address)
				const carol_Vessel_After = await vesselManager.Vessels(carol, erc20.address)

				const alice_debt_After = alice_Vessel_After[th.VESSEL_DEBT_INDEX].toString()
				const bob_debt_After = bob_Vessel_After[th.VESSEL_DEBT_INDEX].toString()
				const carol_debt_After = carol_Vessel_After[th.VESSEL_DEBT_INDEX].toString()

				// check that Dennis' redeemed 20 debt tokens have been cancelled with debt from Bobs's Vessel (8) and Carol's Vessel (10).
				// The remaining lot (2) is sent to Alice's Vessel, who had the best ICR.
				// It leaves her with (3) debt tokens + 50 for gas compensation.
				th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
				assert.equal(bob_debt_After, "0")
				assert.equal(carol_debt_After, "0")

				const dennis_CollBalance_After = toBN(await erc20.balanceOf(dennis))
				const receivedColl = dennis_CollBalance_After.sub(dennis_CollBalance_Before)

				const expectedTotalCollDrawn = calcSoftnedAmount(redemptionAmount, price)
				const expectedReceivedColl = expectedTotalCollDrawn.sub(toBN(collFee))

				th.assertIsApproximatelyEqual(expectedReceivedColl, receivedColl)

				const dennis_DebtTokenBalance_After = (await debtToken.balanceOf(dennis)).toString()
				th.assertIsApproximatelyEqual(
					dennis_DebtTokenBalance_After,
					dennis_DebtTokenBalance_Before.sub(redemptionAmount)
				)
			})

			it("redeemCollateral(): with invalid first hint, non-existent vessel", async () => {
				const { totalDebt: A_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(310, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: alice },
				})
				const { netDebt: B_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraTRIAmount: dec(8, 18),
					extraParams: { from: bob },
				})
				const { netDebt: C_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(250, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: carol },
				})

				const partialRedemptionAmount = toBN(2)
				const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)

				// start Dennis with a high ICR
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(100, 18)),
					extraTRIAmount: redemptionAmount,
					extraParams: { from: dennis },
				})

				const dennis_CollBalance_Before = toBN(await erc20.balanceOf(dennis))
				const dennis_DebtTokenBalance_Before = await debtToken.balanceOf(dennis)
				const price = await priceFeed.getPrice(erc20.address)

				// Find hints for redeeming 20 debt tokens
				const { 1: partialRedemptionHintNewICR } = await vesselManagerOperations.getRedemptionHints(
					erc20.address,
					redemptionAmount,
					price,
					0
				)

				// We don't need to use getApproxHint for this test, since it's not the subject of this
				// test case, and the list is very small, so the correct position is quickly found
				const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedVessels.findInsertPosition(
					erc20.address,
					partialRedemptionHintNewICR,
					dennis,
					dennis
				)

				// skip redemption bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await adminContract.setWhitelistedRedeemer(dennis, true)
				// Dennis redeems 20 debt tokens
				const redemptionTx = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					redemptionAmount,
					erin, // invalid first hint, it doesn’t have a vessel
					upperPartialRedemptionHint,
					lowerPartialRedemptionHint,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: dennis }
				)

				const collFee = th.getEmittedRedemptionValues(redemptionTx)[3]

				const alice_Vessel_After = await vesselManager.Vessels(alice, erc20.address)
				const bob_Vessel_After = await vesselManager.Vessels(bob, erc20.address)
				const carol_Vessel_After = await vesselManager.Vessels(carol, erc20.address)

				const alice_debt_After = alice_Vessel_After[th.VESSEL_DEBT_INDEX].toString()
				const bob_debt_After = bob_Vessel_After[th.VESSEL_DEBT_INDEX].toString()
				const carol_debt_After = carol_Vessel_After[th.VESSEL_DEBT_INDEX].toString()

				// check that Dennis' redeemed 20 debt tokens have been cancelled with debt from Bobs's Vessel (8) and Carol's Vessel (10).
				// The remaining lot (2) is sent to Alice's Vessel, who had the best ICR.
				// It leaves her with (3) debt tokens + 50 for gas compensation.
				th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
				assert.equal(bob_debt_After, "0")
				assert.equal(carol_debt_After, "0")

				const dennis_CollBalance_After = toBN(await erc20.balanceOf(dennis))
				const receivedColl = dennis_CollBalance_After.sub(dennis_CollBalance_Before)

				const expectedTotalCollDrawn = calcSoftnedAmount(redemptionAmount, price)
				const expectedReceivedColl = expectedTotalCollDrawn.sub(toBN(collFee))

				th.assertIsApproximatelyEqual(expectedReceivedColl, receivedColl)

				const dennis_DebtTokenBalance_After = (await debtToken.balanceOf(dennis)).toString()
				th.assertIsApproximatelyEqual(
					dennis_DebtTokenBalance_After,
					dennis_DebtTokenBalance_Before.sub(redemptionAmount)
				)
			})

			it("redeemCollateral(): with invalid first hint, vessel below MCR", async () => {
				const { totalDebt: A_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(310, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: alice },
				})
				const { netDebt: B_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraTRIAmount: dec(8, 18),
					extraParams: { from: bob },
				})
				const { netDebt: C_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(250, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: carol },
				})

				const partialRedemptionAmount = toBN(2)
				const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
				// start Dennis with a high ICR
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(100, 18)),
					extraTRIAmount: redemptionAmount,
					extraParams: { from: dennis },
				})

				const dennis_CollBalance_Before = toBN(await erc20.balanceOf(dennis))
				const dennis_DebtTokenBalance_Before = await debtToken.balanceOf(dennis)

				const price = await priceFeed.getPrice(erc20.address)

				// Increase price to start Erin, and decrease it again so its ICR is under MCR
				await priceFeed.setPrice(erc20.address, price.mul(toBN(2)))
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(2, 18)),
					extraParams: { from: erin },
				})
				await priceFeed.setPrice(erc20.address, price)

				// Find hints for redeeming 20 debt tokens
				const { 1: partialRedemptionHintNewICR } = await vesselManagerOperations.getRedemptionHints(
					erc20.address,
					redemptionAmount,
					price,
					0
				)

				// We don't need to use getApproxHint for this test, since it's not the subject of this
				// test case, and the list is very small, so the correct position is quickly found
				const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedVessels.findInsertPosition(
					erc20.address,
					partialRedemptionHintNewICR,
					dennis,
					dennis
				)

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// Dennis redeems 20 debt tokens
				// Don't pay for gas, as it makes it easier to calculate the received Ether

				await adminContract.setWhitelistedRedeemer(dennis, true)
				const redemptionTx = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					redemptionAmount,
					erin, // invalid vessel, below MCR
					upperPartialRedemptionHint,
					lowerPartialRedemptionHint,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: dennis }
				)

				const collFee = th.getEmittedRedemptionValues(redemptionTx)[3]

				const alice_Vessel_After = await vesselManager.Vessels(alice, erc20.address)
				const bob_Vessel_After = await vesselManager.Vessels(bob, erc20.address)
				const carol_Vessel_After = await vesselManager.Vessels(carol, erc20.address)

				const alice_debt_After = alice_Vessel_After[th.VESSEL_DEBT_INDEX].toString()
				const bob_debt_After = bob_Vessel_After[th.VESSEL_DEBT_INDEX].toString()
				const carol_debt_After = carol_Vessel_After[th.VESSEL_DEBT_INDEX].toString()

				// check that Dennis' redeemed 20 debt tokens have been cancelled with debt from Bobs's Vessel (8) and Carol's Vessel (10).
				// The remaining lot (2) is sent to Alice's Vessel, who had the best ICR.
				// It leaves her with (3) debt tokens + 50 for gas compensation.
				th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))

				assert.equal(bob_debt_After, "0")
				assert.equal(carol_debt_After, "0")

				const dennis_CollBalance_After = toBN(await erc20.balanceOf(dennis))
				const receivedColl = dennis_CollBalance_After.sub(dennis_CollBalance_Before)

				const expectedTotalCollDrawn = calcSoftnedAmount(redemptionAmount, price)
				const expectedReceivedColl = expectedTotalCollDrawn.sub(toBN(collFee))

				th.assertIsApproximatelyEqual(expectedReceivedColl, receivedColl)

				const dennis_DebtTokenBalance_After = (await debtToken.balanceOf(dennis)).toString()
				th.assertIsApproximatelyEqual(
					dennis_DebtTokenBalance_After,
					dennis_DebtTokenBalance_Before.sub(redemptionAmount)
				)
			})

			it("redeemCollateral(): ends the redemption sequence when the token redemption request has been filled", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(100, 18)),
					extraParams: { from: whale },
				})

				// Alice, Bob, Carol, Dennis, Erin open vessels
				const { netDebt: A_debt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraTRIAmount: dec(20, 18),
					extraParams: { from: alice },
				})
				const { netDebt: B_debt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraTRIAmount: dec(20, 18),
					extraParams: { from: bob },
				})
				const { netDebt: C_debt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(290, 16)),
					extraTRIAmount: dec(20, 18),
					extraParams: { from: carol },
				})
				const { totalDebt: D_totalDebt, collateral: D_coll } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: dennis },
				})
				const { totalDebt: E_totalDebt, collateral: E_coll } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: erin },
				})

				const redemptionAmount = A_debt.add(B_debt).add(C_debt)

				// open vessel from redeemer (flyn), who has highest ICR: 100 coll, 100 debtTokens = 20,000%
				const { TRIAmount: F_DebtAmount } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 18)),
					extraTRIAmount: redemptionAmount.mul(toBN(2)),
					extraParams: { from: flyn },
				})

				// skip redemption bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await adminContract.setWhitelistedRedeemer(flyn, true)
				// Flyn redeems collateral
				await vesselManagerOperations.redeemCollateral(
					erc20.address,
					redemptionAmount,
					alice,
					alice,
					alice,
					0,
					0,
					th._100pct,
					{ from: flyn }
				)

				// Check Flyn's redemption has reduced his balance from 100 to (100-60) = 40
				const flynBalance = await debtToken.balanceOf(flyn)
				th.assertIsApproximatelyEqual(flynBalance, F_DebtAmount.sub(redemptionAmount))

				// Check debt of Alice, Bob, Carol
				const alice_Debt = await vesselManager.getVesselDebt(erc20.address, alice)
				const bob_Debt = await vesselManager.getVesselDebt(erc20.address, bob)
				const carol_Debt = await vesselManager.getVesselDebt(erc20.address, carol)

				assert.equal(alice_Debt, 0)
				assert.equal(bob_Debt, 0)
				assert.equal(carol_Debt, 0)

				// check Alice, Bob and Carol vessels are closed by redemption
				const alice_Status = await vesselManager.getVesselStatus(erc20.address, alice)
				const bob_Status = await vesselManager.getVesselStatus(erc20.address, bob)
				const carol_Status = await vesselManager.getVesselStatus(erc20.address, carol)

				assert.equal(alice_Status, 4)
				assert.equal(bob_Status, 4)
				assert.equal(carol_Status, 4)

				// check debt and coll of Dennis, Erin has not been impacted by redemption
				const dennis_Debt = await vesselManager.getVesselDebt(erc20.address, dennis)
				const erin_Debt = await vesselManager.getVesselDebt(erc20.address, erin)

				th.assertIsApproximatelyEqual(dennis_Debt, D_totalDebt)
				th.assertIsApproximatelyEqual(erin_Debt, E_totalDebt)

				const dennis_Coll = await vesselManager.getVesselColl(erc20.address, dennis)
				const erin_Coll = await vesselManager.getVesselColl(erc20.address, erin)

				assert.equal(dennis_Coll.toString(), D_coll.toString())
				assert.equal(erin_Coll.toString(), E_coll.toString())
			})

			it("redeemCollateral(): ends the redemption sequence when max iterations have been reached", async () => {
				// --- SETUP ---
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(100, 18)),
					extraParams: { from: whale },
				})

				// Alice, Bob, Carol open vessels with equal collateral ratio

				const { netDebt: A_debt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(286, 16)),
					extraTRIAmount: dec(20, 18),
					extraParams: { from: alice },
				})
				const { netDebt: B_debt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(286, 16)),
					extraTRIAmount: dec(20, 18),
					extraParams: { from: bob },
				})
				const { netDebt: C_debt_Asset, totalDebt: C_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(286, 16)),
					extraTRIAmount: dec(20, 18),
					extraParams: { from: carol },
				})

				const redemptionAmount_Asset = A_debt_Asset.add(B_debt_Asset)
				const attemptedRedemptionAmount_Asset = redemptionAmount_Asset.add(C_debt_Asset)

				// --- TEST ---

				// open vessel from redeemer.  Redeemer has highest ICR (100ETH, 100 TRI), 20000%
				const { TRIAmount: F_TRIAmount_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 18)),
					extraTRIAmount: redemptionAmount_Asset.mul(toBN(2)),
					extraParams: { from: flyn },
				})

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// Flyn redeems collateral with only two iterations

				await adminContract.setWhitelistedRedeemer(flyn, true)
				await vesselManagerOperations.redeemCollateral(
					erc20.address,
					attemptedRedemptionAmount_Asset,
					alice,
					alice,
					alice,
					0,
					2,
					th._100pct,
					{ from: flyn }
				)

				// Check Flyn's redemption has reduced his balance from 100 to (100-40) = 60 TRI
				const flynBalance = (await debtToken.balanceOf(flyn)).toString()
				th.assertIsApproximatelyEqual(flynBalance, F_TRIAmount_Asset.sub(redemptionAmount_Asset))

				// Check debt of Alice, Bob, Carol

				const alice_Debt_Asset = await vesselManager.getVesselDebt(erc20.address, alice)
				const bob_Debt_Asset = await vesselManager.getVesselDebt(erc20.address, bob)
				const carol_Debt_Asset = await vesselManager.getVesselDebt(erc20.address, carol)

				assert.equal(alice_Debt_Asset, 0)
				assert.equal(bob_Debt_Asset, 0)
				th.assertIsApproximatelyEqual(carol_Debt_Asset, C_totalDebt_Asset)

				// check Alice and Bob vessels are closed, but Carol is not

				const alice_Status_Asset = await vesselManager.getVesselStatus(erc20.address, alice)
				const bob_Status_Asset = await vesselManager.getVesselStatus(erc20.address, bob)
				const carol_Status_Asset = await vesselManager.getVesselStatus(erc20.address, carol)

				assert.equal(alice_Status_Asset, 4)
				assert.equal(bob_Status_Asset, 4)
				assert.equal(carol_Status_Asset, 1)
			})

			it("redeemCollateral(): performs partial redemption if resultant debt is > minimum net debt", async () => {
				await borrowerOperations.openVessel(
					erc20.address,
					dec(1_000, "ether"),
					await getOpenVesselTRIAmount(dec(10_000, 18), erc20.address),
					A,
					A,
					{ from: A }
				)
				await borrowerOperations.openVessel(
					erc20.address,
					dec(1_000, "ether"),
					await getOpenVesselTRIAmount(dec(20_000, 18), erc20.address),
					B,
					B,
					{ from: B }
				)
				await borrowerOperations.openVessel(
					erc20.address,
					dec(1_000, "ether"),
					await getOpenVesselTRIAmount(dec(30_000, 18), erc20.address),
					C,
					C,
					{ from: C }
				)

				// A and C send all their tokens to B
				await debtToken.transfer(B, await debtToken.balanceOf(A), { from: A })
				await debtToken.transfer(B, await debtToken.balanceOf(C), { from: C })

				await vesselManager.setBaseRate(erc20.address, 0)

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// redemption is $55_000
				const redemptionAmount = dec(55_000, 18)
				await th.redeemCollateralAndGetTxObject(B, contracts.core, redemptionAmount, erc20.address)

				// check that A remains active but B and C are closed
				assert.isTrue(await sortedVessels.contains(erc20.address, A))
				assert.isFalse(await sortedVessels.contains(erc20.address, B))
				assert.isFalse(await sortedVessels.contains(erc20.address, C))

				// A's remaining debt = 10,000 (A) + 20,0000 (B) + 30,000 (C) - 55,000 (R) = 5,000
				const A_debt_Asset = await vesselManager.getVesselDebt(erc20.address, A)

				th.assertIsApproximatelyEqual(A_debt_Asset, dec(4600, 18), 1000)
			})

			it("redeemCollateral(): doesn't perform partial redemption if resultant debt would be < minimum net debt", async () => {
				await borrowerOperations.openVessel(
					erc20.address,
					dec(1000, "ether"),
					await getOpenVesselTRIAmount(dec(6000, 18), erc20.address),
					A,
					A,
					{ from: A }
				)
				await borrowerOperations.openVessel(
					erc20.address,
					dec(1000, "ether"),
					await getOpenVesselTRIAmount(dec(20000, 18), erc20.address),
					B,
					B,
					{ from: B }
				)
				await borrowerOperations.openVessel(
					erc20.address,
					dec(1000, "ether"),
					await getOpenVesselTRIAmount(dec(30000, 18), erc20.address),
					C,
					C,
					{ from: C }
				)

				// A and C send all their tokens to B
				await debtToken.transfer(B, await debtToken.balanceOf(A), { from: A })
				await debtToken.transfer(B, await debtToken.balanceOf(C), { from: C })

				await vesselManager.setBaseRate(erc20.address, 0)

				// Skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// TRI redemption is 55000 TRI
				const TRIRedemption = dec(55000, 18)
				await th.redeemCollateralAndGetTxObject(B, contracts.core, TRIRedemption, erc20.address)

				// Check B, C closed and A remains active

				assert.isTrue(await sortedVessels.contains(erc20.address, A))
				assert.isFalse(await sortedVessels.contains(erc20.address, B))
				assert.isFalse(await sortedVessels.contains(erc20.address, C))

				// A's remaining debt would be 29950 + 19950 + 5950 + 50 - 55000 = 900.
				// Since this is below the min net debt of 100, A should be skipped and untouched by the redemption
				const A_debt_Asset = await vesselManager.getVesselDebt(erc20.address, A)
				await th.assertIsApproximatelyEqual(A_debt_Asset, dec(6000, 18))
			})

			it("redeemCollateral(): doesn't perform the final partial redemption in the sequence if the hint is out-of-date", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(363, 16)),
					extraTRIAmount: dec(5, 18),
					extraParams: { from: alice },
				})
				const { netDebt: B_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(344, 16)),
					extraTRIAmount: dec(8, 18),
					extraParams: { from: bob },
				})
				const { netDebt: C_netDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(333, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: carol },
				})
				const partialRedemptionAmount = toBN(2)
				const fullfilledRedemptionAmount = C_netDebt.add(B_netDebt)
				const redemptionAmount = fullfilledRedemptionAmount.add(partialRedemptionAmount)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(100, 18)),
					extraTRIAmount: redemptionAmount,
					extraParams: { from: dennis },
				})

				const dennis_CollBalance_Before = toBN(await erc20.balanceOf(dennis))
				const dennis_DebtTokenBalance_Before = await debtToken.balanceOf(dennis)
				const price = await priceFeed.getPrice(erc20.address)

				const { 0: firstRedemptionHint, 1: partialRedemptionHintNewICR } =
					await vesselManagerOperations.getRedemptionHints(erc20.address, redemptionAmount, price, 0)
				const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedVessels.findInsertPosition(
					erc20.address,
					partialRedemptionHintNewICR,
					dennis,
					dennis
				)

				const frontRunRedemption = toBN(dec(1, 18))

				// Oops, another transaction gets in the way
				{
					const { 0: firstRedemptionHint, 1: partialRedemptionHintNewICR } =
						await vesselManagerOperations.getRedemptionHints(erc20.address, dec(1, 18), price, 0)
					const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } =
						await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNewICR, dennis, dennis)

					// skip redemption bootstrapping phase
					await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

					await adminContract.setWhitelistedRedeemer(alice, true)
					// Alice redeems 1 debt token from Carol's Vessel
					await vesselManagerOperations.redeemCollateral(
						erc20.address,
						frontRunRedemption,
						firstRedemptionHint,
						upperPartialRedemptionHint,
						lowerPartialRedemptionHint,
						partialRedemptionHintNewICR,
						0,
						th._100pct,
						{ from: alice }
					)
				}

				await adminContract.setWhitelistedRedeemer(dennis, true)
				// Dennis tries to redeem 20 debt tokens
				const redemptionTx = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					redemptionAmount,
					firstRedemptionHint,
					upperPartialRedemptionHint,
					lowerPartialRedemptionHint,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: dennis }
				)

				const collFee = th.getEmittedRedemptionValues(redemptionTx)[3]

				// Since Alice already redeemed 1 debt token from Carol's Vessel, Dennis was able to redeem:
				//  - 9 debt tokens from Carol's
				//  - 8 debt tokens from Bob's
				// for a total of 17 debt tokens.

				// Dennis calculated his hint for redeeming 2 debt tokens from Alice's Vessel, but after Alice's transaction
				// got in the way, he would have needed to redeem 3 debt tokens to fully complete his redemption of 20 debt tokens.
				// This would have required a different hint, therefore he ended up with a partial redemption.

				const dennis_CollBalance_After = toBN(await erc20.balanceOf(dennis))
				const receivedColl = dennis_CollBalance_After.sub(dennis_CollBalance_Before)

				// Expect only 17 worth of collateral drawn
				const expectedTotalCollDrawn = calcSoftnedAmount(fullfilledRedemptionAmount.sub(frontRunRedemption), price)
				const expectedReceivedColl = expectedTotalCollDrawn.sub(collFee)

				th.assertIsApproximatelyEqual(expectedReceivedColl, receivedColl)

				const dennis_DebtTokenBalance_After = (await debtToken.balanceOf(dennis)).toString()
				th.assertIsApproximatelyEqual(
					dennis_DebtTokenBalance_After,
					dennis_DebtTokenBalance_Before.sub(fullfilledRedemptionAmount.sub(frontRunRedemption))
				)
			})

			// active debt cannot be zero, as there’s a positive min debt enforced, and at least a vessel must exist
			it.skip("redeemCollateral(): can redeem if there is zero active debt but non-zero debt in DefaultPool", async () => {
				// --- SETUP ---

				const amount = await getOpenVesselTRIAmount(dec(110, 18))

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(133, 16)),
					extraTRIAmount: amount,
					extraParams: { from: bob },
				})

				await debtToken.transfer(carol, amount.mul(toBN(2)), { from: bob })

				const price = dec(100, 18)
				await priceFeed.setPrice(erc20.address, price)

				// Liquidate Bob's Vessel
				await vesselManagerOperations.liquidateVessels(erc20.address, 1)

				// --- TEST ---

				const carol_ETHBalance_Before_Asset = toBN(await erc20.balanceOf(carol))
				console.log(carol_ETHBalance_Before_Asset.toString())

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				const redemptionTx_Asset = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					amount,
					alice,
					"0x0000000000000000000000000000000000000000",
					"0x0000000000000000000000000000000000000000",
					"10367038690476190477",
					0,
					th._100pct,
					{
						from: carol,
						// gasPrice: 0,
					}
				)

				const ETHFee_Asset = th.getEmittedRedemptionValues(redemptionTx_Asset)[3]

				const carol_ETHBalance_After_Asset = toBN(await erc20.address(carol))

				const expectedTotalETHDrawn = toBN(amount).div(toBN(100)) // convert 100 TRI to ETH at ETH:USD price of 100
				const expectedReceivedETH_Asset = expectedTotalETHDrawn.sub(ETHFee_Asset)

				const receivedETH_Asset = carol_ETHBalance_After_Asset.sub(carol_ETHBalance_Before_Asset)
				assert.isTrue(expectedReceivedETH_Asset.eq(receivedETH_Asset))

				const carol_TRIBalance_After = (await debtToken.balanceOf(carol)).toString()
				assert.equal(carol_TRIBalance_After, "0")
			})
			it("redeemCollateral(): doesn't touch Vessels with ICR < 110%", async () => {
				// --- SETUP ---

				const { netDebt: A_debt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(13, 18)),
					extraParams: { from: alice },
				})
				const { TRIAmount: B_TRIAmount_Asset, totalDebt: B_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(133, 16)),
					extraTRIAmount: A_debt_Asset,
					extraParams: { from: bob },
				})

				await debtToken.transfer(carol, B_TRIAmount_Asset, { from: bob })

				// Put Bob's Vessel below 110% ICR
				const price = dec(100, 18)
				await priceFeed.setPrice(erc20.address, price)

				// --- TEST ---

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await adminContract.setWhitelistedRedeemer(carol, true)
				await vesselManagerOperations.redeemCollateral(
					erc20.address,
					A_debt_Asset,
					alice,
					"0x0000000000000000000000000000000000000000",
					"0x0000000000000000000000000000000000000000",
					0,
					0,
					th._100pct,
					{ from: carol }
				)

				// Alice's Vessel was cleared of debt

				const { debt: alice_Debt_After_Asset } = await vesselManager.Vessels(alice, erc20.address)
				assert.equal(alice_Debt_After_Asset, "0")

				// Bob's Vessel was left untouched
				const { debt: bob_Debt_After_Asset } = await vesselManager.Vessels(bob, erc20.address)
				th.assertIsApproximatelyEqual(bob_Debt_After_Asset, B_totalDebt_Asset)
			})

			it("redeemCollateral(): finds the last Vessel with ICR == 110% even if there is more than one", async () => {
				// --- SETUP ---
				const amount1 = toBN(dec(100, 18))

				const { totalDebt: A_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: amount1,
					extraParams: { from: alice },
				})
				const { totalDebt: B_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: amount1,
					extraParams: { from: bob },
				})
				const { totalDebt: C_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: amount1,
					extraParams: { from: carol },
				})

				const redemptionAmount_Asset = C_totalDebt_Asset.add(B_totalDebt_Asset).add(A_totalDebt_Asset)
				const { totalDebt: D_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(195, 16)),
					extraTRIAmount: redemptionAmount_Asset,
					extraParams: { from: dennis },
				})

				// This will put Dennis slightly below 110%, and everyone else exactly at 110%
				const price = "110" + _18_zeros
				await priceFeed.setPrice(erc20.address, price)

				const orderOfVessels = []
				const orderOfVessels_Asset = []
				let current_Asset = await sortedVessels.getFirst(erc20.address)

				while (current_Asset !== "0x0000000000000000000000000000000000000000") {
					orderOfVessels_Asset.push(current_Asset)
					current_Asset = await sortedVessels.getNext(erc20.address, current_Asset)
				}

				assert.deepEqual(orderOfVessels_Asset, [carol, bob, alice, dennis])

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(100, 18)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: whale },
				})

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await adminContract.setWhitelistedRedeemer(dennis, true)
				const tx_Asset = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					redemptionAmount_Asset,
					carol, // try to trick redeemCollateral by passing a hint that doesn't exactly point to the
					// last Vessel with ICR == 110% (which would be Alice's)
					"0x0000000000000000000000000000000000000000",
					"0x0000000000000000000000000000000000000000",
					0,
					0,
					th._100pct,
					{ from: dennis }
				)

				const { debt: alice_Debt_After_Asset } = await vesselManager.Vessels(alice, erc20.address)
				assert.equal(alice_Debt_After_Asset, "0")

				const { debt: bob_Debt_After_Asset } = await vesselManager.Vessels(bob, erc20.address)
				assert.equal(bob_Debt_After_Asset, "0")

				const { debt: carol_Debt_After_Asset } = await vesselManager.Vessels(carol, erc20.address)
				assert.equal(carol_Debt_After_Asset, "0")

				const { debt: dennis_Debt_After_Asset } = await vesselManager.Vessels(dennis, erc20.address)
				th.assertIsApproximatelyEqual(dennis_Debt_After_Asset, D_totalDebt_Asset)
			})

			it("redeemCollateral(): reverts when TCR < MCR", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraParams: { from: bob },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraParams: { from: carol },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(196, 16)),
					extraParams: { from: dennis },
				})

				// This will put Dennis slightly below 110%, and everyone else exactly at 110%

				await priceFeed.setPrice(erc20.address, "110" + _18_zeros)
				const price = await priceFeed.getPrice(erc20.address)

				const TCR_Asset = await th.getTCR(contracts.core, erc20.address)

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await assertRevert(
					th.redeemCollateral(carol, contracts.core, dec(270, 18), erc20.address),
					"VesselManager: Cannot redeem when TCR < MCR"
				)
			})

			it("redeemCollateral(): reverts when argument _amount is 0", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})

				// Alice opens vessel and transfers 500TRI to Erin, the would-be redeemer
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(500, 18),
					extraParams: { from: alice },
				})
				await debtToken.transfer(erin, dec(500, 18), { from: alice })

				// B, C and D open vessels

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraParams: { from: bob },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraParams: { from: carol },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraParams: { from: dennis },
				})

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// Erin attempts to redeem with _amount = 0
				const redemptionTxPromise_Asset = vesselManagerOperations.redeemCollateral(
					erc20.address,
					0,
					erin,
					erin,
					erin,
					0,
					0,
					th._100pct,
					{ from: erin }
				)
				await assertRevert(redemptionTxPromise_Asset, "VesselManager: Amount must be greater than zero")
			})

			it("redeemCollateral(): reverts if max fee > 100%", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(20, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(30, 18),
					extraParams: { from: C },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(40, 18),
					extraParams: { from: D },
				})

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await assertRevert(
					th.redeemCollateralAndGetTxObject(A, contracts.core, dec(10, 18), erc20.address, dec(2, 18)),
					"Max fee percentage must be between 0.5% and 100%"
				)
				await assertRevert(
					th.redeemCollateralAndGetTxObject(A, contracts.core, dec(10, 18), erc20.address, "1000000000000000001"),
					"Max fee percentage must be between 0.5% and 100%"
				)
			})

			it("redeemCollateral(): reverts if max fee < 0.5%", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(10, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(20, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(30, 18),
					extraParams: { from: C },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(40, 18),
					extraParams: { from: D },
				})

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await assertRevert(
					th.redeemCollateralAndGetTxObject(A, contracts.core, dec(10, 18), erc20.address, 0),
					"Max fee percentage must be between 0.5% and 100%"
				)
				await assertRevert(
					th.redeemCollateralAndGetTxObject(A, contracts.core, dec(10, 18), erc20.address, 1),
					"Max fee percentage must be between 0.5% and 100%"
				)
				await assertRevert(
					th.redeemCollateralAndGetTxObject(A, contracts.core, dec(10, 18), erc20.address, "4999999999999999"),
					"Max fee percentage must be between 0.5% and 100%"
				)
			})

			it("redeemCollateral(): reverts if fee exceeds max fee percentage", async () => {
				const { totalDebt: A_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(80, 18),
					extraParams: { from: A },
				})
				const { totalDebt: B_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(90, 18),
					extraParams: { from: B },
				})
				const { totalDebt: C_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				const expectedTotalSupply_Asset = A_totalDebt_Asset.add(B_totalDebt_Asset).add(C_totalDebt_Asset)

				// Check total TRI supply
				const totalSupply = await debtToken.totalSupply()
				th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply_Asset)

				await vesselManager.setBaseRate(erc20.address, 0)

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// TRI redemption is 27 USD: a redemption that incurs a fee of 27/(270 * 2) = 5%
				const attemptedTRIRedemption_Asset = expectedTotalSupply_Asset.div(toBN(10))

				// Max fee is <5%
				const lessThan5pct = "49999999999999999"
				await assertRevert(
					th.redeemCollateralAndGetTxObject(
						A,
						contracts.core,
						attemptedTRIRedemption_Asset,
						erc20.address,
						lessThan5pct
					),
					"Fee exceeded provided maximum"
				)

				await vesselManager.setBaseRate(erc20.address, 0)

				// Max fee is 1%
				await assertRevert(
					th.redeemCollateralAndGetTxObject(
						A,
						contracts.core,
						attemptedTRIRedemption_Asset,
						erc20.address,
						dec(1, 16)
					),
					"Fee exceeded provided maximum"
				)

				await vesselManager.setBaseRate(erc20.address, 0)

				// Max fee is 3.754%
				await assertRevert(
					th.redeemCollateralAndGetTxObject(
						A,
						contracts.core,
						attemptedTRIRedemption_Asset,
						erc20.address,
						dec(3754, 13)
					),
					"Fee exceeded provided maximum"
				)

				await vesselManager.setBaseRate(erc20.address, 0)

				// Max fee is 0.5%
				await assertRevert(
					th.redeemCollateralAndGetTxObject(
						A,
						contracts.core,
						attemptedTRIRedemption_Asset,
						erc20.address,
						dec(5, 15)
					),
					"Fee exceeded provided maximum"
				)
			})

			it("redeemCollateral(): succeeds if fee is less than max fee percentage", async () => {
				const { totalDebt: A_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(9500, 18),
					extraParams: { from: A },
				})
				const { totalDebt: B_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(395, 16)),
					extraTRIAmount: dec(9000, 18),
					extraParams: { from: B },
				})
				const { totalDebt: C_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(390, 16)),
					extraTRIAmount: dec(10000, 18),
					extraParams: { from: C },
				})

				const expectedTotalSupply_Asset = A_totalDebt_Asset.add(B_totalDebt_Asset).add(C_totalDebt_Asset)

				// Check total TRI supply
				const totalSupply = await debtToken.totalSupply()
				th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply_Asset)

				await vesselManager.setBaseRate(erc20.address, 0)

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// TRI redemption fee with 10% of the supply will be 0.5% + 1/(10*2)
				const attemptedTRIRedemption_Asset = expectedTotalSupply_Asset.div(toBN(10))

				// Attempt with maxFee > 5.5%
				const price = await priceFeed.getPrice(erc20.address)
				const ETHDrawn_Asset = attemptedTRIRedemption_Asset.mul(mv._1e18BN).div(price)

				const slightlyMoreThanFee_Asset = await vesselManager.getRedemptionFeeWithDecay(erc20.address, ETHDrawn_Asset)

				const tx1_Asset = await th.redeemCollateralAndGetTxObject(
					A,
					contracts.core,
					attemptedTRIRedemption_Asset,
					erc20.address,
					slightlyMoreThanFee_Asset
				)
				assert.isTrue(tx1_Asset.receipt.status)

				await vesselManager.setBaseRate(erc20.address, 0)

				// Attempt with maxFee = 5.5%
				const exactSameFee_Asset = await vesselManager.getRedemptionFeeWithDecay(erc20.address, ETHDrawn_Asset)

				const tx2_Asset = await th.redeemCollateralAndGetTxObject(
					C,
					contracts.core,
					attemptedTRIRedemption_Asset,
					erc20.address,
					exactSameFee_Asset
				)
				assert.isTrue(tx2_Asset.receipt.status)

				await vesselManager.setBaseRate(erc20.address, 0)

				// Max fee is 10%
				const tx3_Asset = await th.redeemCollateralAndGetTxObject(
					B,
					contracts.core,
					attemptedTRIRedemption_Asset,
					erc20.address,
					dec(1, 17)
				)
				assert.isTrue(tx3_Asset.receipt.status)

				await vesselManager.setBaseRate(erc20.address, 0)

				// Max fee is 37.659%

				const tx4_Asset = await th.redeemCollateralAndGetTxObject(
					A,
					contracts.core,
					attemptedTRIRedemption_Asset,
					erc20.address,
					dec(37659, 13)
				)
				assert.isTrue(tx4_Asset.receipt.status)

				await vesselManager.setBaseRate(erc20.address, 0)

				// Max fee is 100%

				const tx5_Asset = await th.redeemCollateralAndGetTxObject(
					C,
					contracts.core,
					attemptedTRIRedemption_Asset,
					erc20.address,
					dec(1, 18)
				)
				assert.isTrue(tx5_Asset.receipt.status)
			})

			it("redeemCollateral(): doesn't affect the Stability Pool deposits or ETH gain of redeemed-from vessels", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})

				// B, C, D, F open vessel

				const { totalDebt: B_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: bob },
				})
				const { totalDebt: C_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(195, 16)),
					extraTRIAmount: dec(200, 18),
					extraParams: { from: carol },
				})
				const { totalDebt: D_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(400, 18),
					extraParams: { from: dennis },
				})
				const { totalDebt: F_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: flyn },
				})

				const redemptionAmount_Asset = B_totalDebt_Asset.add(C_totalDebt_Asset)
					.add(D_totalDebt_Asset)
					.add(F_totalDebt_Asset)

				// Alice opens vessel and transfers TRI to Erin, the would-be redeemer
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: redemptionAmount_Asset,
					extraParams: { from: alice },
				})
				await debtToken.transfer(erin, redemptionAmount_Asset, {
					from: alice,
				})

				// B, C, D deposit some of their tokens to the Stability Pool

				await stabilityPool.provideToSP(dec(50, 18), validCollateral, { from: bob })
				await stabilityPool.provideToSP(dec(150, 18), validCollateral, { from: carol })
				await stabilityPool.provideToSP(dec(200, 18), validCollateral, { from: dennis })

				let price = await priceFeed.getPrice(erc20.address)

				const bob_ICR_before_Asset = await vesselManager.getCurrentICR(erc20.address, bob, price)
				const carol_ICR_before_Asset = await vesselManager.getCurrentICR(erc20.address, carol, price)
				const dennis_ICR_before_Asset = await vesselManager.getCurrentICR(erc20.address, dennis, price)

				// Price drops
				await priceFeed.setPrice(erc20.address, dec(100, 18))

				assert.isTrue(await sortedVessels.contains(erc20.address, flyn))


				// Price bounces back, bringing B, C, D back above MCRw
				await priceFeed.setPrice(erc20.address, dec(200, 18))

				const bob_SPDeposit_before_Asset = (await stabilityPool.getCompoundedDebtTokenDeposits(bob)).toString()
				const carol_SPDeposit_before_Asset = (await stabilityPool.getCompoundedDebtTokenDeposits(carol)).toString()
				const dennis_SPDeposit_before_Asset = (await stabilityPool.getCompoundedDebtTokenDeposits(dennis)).toString()

				const idx = validCollateral.indexOf(erc20.address)
				const bob_ETHGain_before_Asset = (await stabilityPool.getDepositorGains(bob, validCollateral))[1][
					idx
				].toString()
				const carol_ETHGain_before_Asset = (await stabilityPool.getDepositorGains(carol, validCollateral))[1][
					idx
				].toString()
				const dennis_ETHGain_before_Asset = (await stabilityPool.getDepositorGains(dennis, validCollateral))[1][
					idx
				].toString()

				// Check the remaining TRI and ETH in Stability Pool after liquidation is non-zero

				const TRIinSP_Asset = await stabilityPool.getTotalDebtTokenDeposits()
				const ETHinSP_Asset = await stabilityPool.getCollateral(erc20.address)

				assert.isTrue(TRIinSP_Asset.gte(mv._zeroBN))
				assert.isTrue(ETHinSP_Asset.gte(mv._zeroBN))

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// Erin redeems TRI
				await th.redeemCollateral(erin, contracts.core, redemptionAmount_Asset, erc20.address, th._100pct)

				price = await priceFeed.getPrice(erc20.address)

				const bob_ICR_after_Asset = await vesselManager.getCurrentICR(erc20.address, bob, price)
				const carol_ICR_after_Asset = await vesselManager.getCurrentICR(erc20.address, carol, price)
				const dennis_ICR_after_Asset = await vesselManager.getCurrentICR(erc20.address, dennis, price)

				// Check ICR of B, C and D vessels has increased,i.e. they have been hit by redemptions
				assert.isTrue(bob_ICR_after_Asset.gte(bob_ICR_before_Asset))
				assert.isTrue(carol_ICR_after_Asset.gte(carol_ICR_before_Asset))
				assert.isTrue(dennis_ICR_after_Asset.gte(dennis_ICR_before_Asset))

				const bob_SPDeposit_after_Asset = (await stabilityPool.getCompoundedDebtTokenDeposits(bob)).toString()
				const carol_SPDeposit_after_Asset = (await stabilityPool.getCompoundedDebtTokenDeposits(carol)).toString()
				const dennis_SPDeposit_after_Asset = (await stabilityPool.getCompoundedDebtTokenDeposits(dennis)).toString()

				const bob_ETHGain_after_Asset = (await stabilityPool.getDepositorGains(bob, validCollateral))[1][idx].toString()
				const carol_ETHGain_after_Asset = (await stabilityPool.getDepositorGains(carol, validCollateral))[1][
					idx
				].toString()
				const dennis_ETHGain_after_Asset = (await stabilityPool.getDepositorGains(dennis, validCollateral))[1][
					idx
				].toString()

				// Check B, C, D Stability Pool deposits and ETH gain have not been affected by redemptions from their vessels
				assert.equal(bob_SPDeposit_before_Asset, bob_SPDeposit_after_Asset)
				assert.equal(carol_SPDeposit_before_Asset, carol_SPDeposit_after_Asset)
				assert.equal(dennis_SPDeposit_before_Asset, dennis_SPDeposit_after_Asset)

				assert.equal(bob_ETHGain_before_Asset, bob_ETHGain_after_Asset)
				assert.equal(carol_ETHGain_before_Asset, carol_ETHGain_after_Asset)
				assert.equal(dennis_ETHGain_before_Asset, dennis_ETHGain_after_Asset)
			})

			it("redeemCollateral(): caller can redeem their entire debtToken balance", async () => {
				const { collateral: W_coll, totalDebt: W_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})

				// Alice opens vessel and transfers 400 debt tokens to Erin, the would-be redeemer
				const { collateral: A_coll, totalDebt: A_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(400, 18),
					extraParams: { from: alice },
				})
				await debtToken.transfer(erin, toBN(dec(400, 18)), { from: alice })

				// B, C, D open vessels
				const { collateral: B_coll, totalDebt: B_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(590, 18),
					extraParams: { from: bob },
				})
				const { collateral: C_coll, totalDebt: C_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(1990, 18),
					extraParams: { from: carol },
				})
				const { collateral: D_coll, totalDebt: D_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(500, 16)),
					extraTRIAmount: dec(1990, 18),
					extraParams: { from: dennis },
				})

				const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt).add(D_totalDebt)
				const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

				// Get active debt and coll before redemption
				const activePool_debt_before = await activePool.getDebtTokenBalance(erc20.address)
				const activePool_coll_before = await activePool.getAssetBalance(erc20.address)

				th.assertIsApproximatelyEqual(activePool_debt_before.toString(), totalDebt)
				assert.equal(activePool_coll_before.toString(), totalColl)

				const price = await priceFeed.getPrice(erc20.address)

				// skip redemption bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// Erin attempts to redeem 400 debt tokens
				const { 0: firstRedemptionHint, 1: partialRedemptionHintNewICR } =
					await vesselManagerOperations.getRedemptionHints(erc20.address, dec(400, 18), price, 0)

				const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedVessels.findInsertPosition(
					erc20.address,
					partialRedemptionHintNewICR,
					erin,
					erin
				)

				await adminContract.setWhitelistedRedeemer(erin, true)
				await vesselManagerOperations.redeemCollateral(
					erc20.address,
					dec(400, 18),
					firstRedemptionHint,
					upperPartialRedemptionHint,
					lowerPartialRedemptionHint,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: erin }
				)

				// Check activePool debt reduced by 400 debt tokens
				const activePool_debt_after = await activePool.getDebtTokenBalance(erc20.address)
				assert.equal(activePool_debt_before.sub(activePool_debt_after), dec(400, 18))

				// Check ActivePool coll reduced by $400 worth of collateral: at Coll:USD price of $200, this should be 2,
				// therefore, remaining ActivePool coll should be 198
				const activePool_coll_after = await activePool.getAssetBalance(erc20.address)
				const expectedCollWithdrawn = calcSoftnedAmount(toBN(dec(400, 18)), price)
				assert.equal(activePool_coll_after.toString(), activePool_coll_before.sub(expectedCollWithdrawn))

				// Check Erin's balance after
				const erin_balance_after = (await debtToken.balanceOf(erin)).toString()
				assert.equal(erin_balance_after, "0")
			})

			it("redeemCollateral(): reverts when requested redemption amount exceeds caller's debt token token balance", async () => {
				const { collateral: W_coll_Asset, totalDebt: W_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})

				// Alice opens vessel and transfers 400 TRI to Erin, the would-be redeemer
				const { collateral: A_coll_Asset, totalDebt: A_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(400, 18),
					extraParams: { from: alice },
				})
				await debtToken.transfer(erin, toBN(dec(400, 18)).mul(toBN(2)), { from: alice })

				// Check Erin's balance before
				const erin_balance_before = await debtToken.balanceOf(erin)
				assert.equal(erin_balance_before, toBN(dec(400, 18)).mul(toBN(2)).toString())

				// B, C, D open vessel

				const { collateral: B_coll_Asset, totalDebt: B_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(590, 18),
					extraParams: { from: bob },
				})
				const { collateral: C_coll_Asset, totalDebt: C_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(1990, 18),
					extraParams: { from: carol },
				})
				const { collateral: D_coll_Asset, totalDebt: D_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(500, 16)),
					extraTRIAmount: dec(1990, 18),
					extraParams: { from: dennis },
				})

				const totalDebt_Asset = W_totalDebt_Asset.add(A_totalDebt_Asset)
					.add(B_totalDebt_Asset)
					.add(C_totalDebt_Asset)
					.add(D_totalDebt_Asset)
				const totalColl_Asset = W_coll_Asset.add(A_coll_Asset).add(B_coll_Asset).add(C_coll_Asset).add(D_coll_Asset)

				// Get active debt and coll before redemption

				const activePool_debt_before_Asset = await activePool.getDebtTokenBalance(erc20.address)
				const activePool_coll_before_Asset = (await activePool.getAssetBalance(erc20.address)).toString()

				th.assertIsApproximatelyEqual(activePool_debt_before_Asset, totalDebt_Asset)
				assert.equal(activePool_coll_before_Asset, totalColl_Asset)

				const price = await priceFeed.getPrice(erc20.address)

				let firstRedemptionHint_Asset
				let partialRedemptionHintNICR_Asset

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// Erin tries to redeem 1000 TRI
				try {
					;({ 0: firstRedemptionHint_Asset, 1: partialRedemptionHintNICR_Asset } =
						await vesselManagerOperations.getRedemptionHints(erc20.address, dec(1000, 18), price, 0))

					const { 0: upperPartialRedemptionHint_1_Asset, 1: lowerPartialRedemptionHint_1_Asset } =
						await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNICR_Asset, erin, erin)

					await adminContract.setWhitelistedRedeemer(erin, true)
					const redemptionTx_Asset = await vesselManagerOperations.redeemCollateral(
						erc20.address,
						dec(1000, 18),
						firstRedemptionHint_Asset,
						upperPartialRedemptionHint_1_Asset,
						lowerPartialRedemptionHint_1_Asset,
						partialRedemptionHintNICR_Asset,
						0,
						th._100pct,
						{ from: erin }
					)

					assert.isFalse(redemptionTx_Asset.receipt.status)
				} catch (error) {
					assert.include(error.message, "revert")
					assert.include(error.message, "VesselManagerOperations__InsufficientDebtTokenBalance")
				}

				// Erin tries to redeem 801 TRI
				try {
					;({ 0: firstRedemptionHint_Asset, 1: partialRedemptionHintNICR_Asset } =
						await vesselManagerOperations.getRedemptionHints(erc20.address, "801000000000000000000", price, 0))

					const { 0: upperPartialRedemptionHint_2_Asset, 1: lowerPartialRedemptionHint_2_Asset } =
						await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNICR_Asset, erin, erin)

					const redemptionTx_Asset = await vesselManagerOperations.redeemCollateral(
						erc20.address,
						"801000000000000000000",
						firstRedemptionHint_Asset,
						upperPartialRedemptionHint_2_Asset,
						lowerPartialRedemptionHint_2_Asset,
						partialRedemptionHintNICR_Asset,
						0,
						th._100pct,
						{ from: erin }
					)

					assert.isFalse(redemptionTx_Asset.receipt.status)
				} catch (error) {
					assert.include(error.message, "revert")
					assert.include(error.message, "VesselManagerOperations__InsufficientDebtTokenBalance")
				}

				// Erin tries to redeem 239482309 TRI

				try {
					;({ 0: firstRedemptionHint_Asset, 1: partialRedemptionHintNICR_Asset } =
						await vesselManagerOperations.getRedemptionHints(erc20.address, "239482309000000000000000000", price, 0))

					const { 0: upperPartialRedemptionHint_3_Asset, 1: lowerPartialRedemptionHint_3_Asset } =
						await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNICR_Asset, erin, erin)

					const redemptionTx_Asset = await vesselManagerOperations.redeemCollateral(
						erc20.address,
						"239482309000000000000000000",
						firstRedemptionHint_Asset,
						upperPartialRedemptionHint_3_Asset,
						lowerPartialRedemptionHint_3_Asset,
						partialRedemptionHintNICR_Asset,
						0,
						th._100pct,
						{ from: erin }
					)

					assert.isFalse(redemptionTx_Asset.receipt.status)
				} catch (error) {
					assert.include(error.message, "revert")
					assert.include(error.message, "VesselManagerOperations__InsufficientDebtTokenBalance")
				}

				// Erin tries to redeem 2^256 - 1 TRI
				const maxBytes32 = toBN("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")

				try {
					;({ 0: firstRedemptionHint_Asset, 1: partialRedemptionHintNICR_Asset } =
						await vesselManagerOperations.getRedemptionHints(erc20.address, "239482309000000000000000000", price, 0))

					const { 0: upperPartialRedemptionHint_4_Asset, 1: lowerPartialRedemptionHint_4_Asset } =
						await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNICR_Asset, erin, erin)

					const redemptionTx_Asset = await vesselManagerOperations.redeemCollateral(
						erc20.address,
						maxBytes32,
						firstRedemptionHint_Asset,
						upperPartialRedemptionHint_4_Asset,
						lowerPartialRedemptionHint_4_Asset,
						partialRedemptionHintNICR_Asset,
						0,
						th._100pct,
						{ from: erin }
					)

					assert.isFalse(redemptionTx_Asset.receipt.status)
				} catch (error) {
					assert.include(error.message, "revert")
					assert.include(error.message, "VesselManagerOperations__InsufficientDebtTokenBalance")
				}
			})

			it("redeemCollateral(): value of issued collateral == face value of redeemed debtToken (assuming 1 debtToken has value of $1)", async () => {
				const { collateral: W_coll } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				// Alice opens vessel and transfers $2,000 debt tokens each to Erin, Flyn, Graham
				const { collateral: A_coll } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(400, 16)),
					extraTRIAmount: dec(4990, 18),
					extraParams: { from: alice },
				})
				await debtToken.transfer(erin, toBN(dec(1_000, 18)).mul(toBN(2)), { from: alice })
				await debtToken.transfer(flyn, toBN(dec(1_000, 18)).mul(toBN(2)), { from: alice })
				await debtToken.transfer(graham, toBN(dec(1_000, 18)).mul(toBN(2)), { from: alice })

				// B, C, D open vessels
				const { collateral: B_coll } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(300, 16)),
					extraTRIAmount: dec(1_590, 18),
					extraParams: { from: bob },
				})
				const { collateral: C_coll } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(600, 16)),
					extraTRIAmount: dec(1_090, 18),
					extraParams: { from: carol },
				})
				const { collateral: D_coll } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(800, 16)),
					extraTRIAmount: dec(1_090, 18),
					extraParams: { from: dennis },
				})

				const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

				const price = await priceFeed.getPrice(erc20.address)

				const _120_ = "120000000000000000000"
				const _373_ = "373000000000000000000"
				const _950_ = "950000000000000000000"

				// Check assets in activePool
				const activePoolBalance0 = await activePool.getAssetBalance(erc20.address)
				assert.equal(activePoolBalance0, totalColl.toString())

				// skip redemption bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				await adminContract.setWhitelistedRedeemer(erin, true)
				// Erin redeems 120 debt tokens
				await ({ 0: firstRedemptionHint, 1: partialRedemptionHintNewICR } =
					await vesselManagerOperations.getRedemptionHints(erc20.address, _120_, price, 0))
				const { 0: upperPartialRedemptionHint_1, 1: lowerPartialRedemptionHint_1 } =
					await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNewICR, erin, erin)
				const redemption_1 = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					_120_,
					firstRedemptionHint,
					upperPartialRedemptionHint_1,
					lowerPartialRedemptionHint_1,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: erin }
				)
				assert.isTrue(redemption_1.receipt.status)

				// 120 debt tokens redeemed = expect $120 worth of collateral removed

				const activePoolBalance1 = await activePool.getAssetBalance(erc20.address)
				const expectedActivePoolBalance1 = activePoolBalance0.sub(calcSoftnedAmount(toBN(_120_), price))
				assert.equal(activePoolBalance1.toString(), expectedActivePoolBalance1.toString())

				// Flyn redeems 373 debt tokens
				;({ 0: firstRedemptionHint, 1: partialRedemptionHintNewICR } = await vesselManagerOperations.getRedemptionHints(
					erc20.address,
					_373_,
					price,
					0
				))
				const { 0: upperPartialRedemptionHint_2, 1: lowerPartialRedemptionHint_2 } =
					await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNewICR, flyn, flyn)

				await adminContract.setWhitelistedRedeemer(flyn, true)
				const redemption_2 = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					_373_,
					firstRedemptionHint,
					upperPartialRedemptionHint_2,
					lowerPartialRedemptionHint_2,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: flyn }
				)
				assert.isTrue(redemption_2.receipt.status)

				// 373 debt tokens redeemed = expect $373 worth of collateral removed
				// At Coll:USD price of $200,
				// Coll removed = (373/200) = 1.865 * 97% (softening) = 1.80905
				// Total active collateral = 279.418 - 1.80905 = 277.60895
				const activePoolBalance2 = await activePool.getAssetBalance(erc20.address)
				const expectedActivePoolBalance2 = activePoolBalance1.sub(calcSoftnedAmount(toBN(_373_), price))
				assert.equal(activePoolBalance2.toString(), expectedActivePoolBalance2.toString())

				// Graham redeems 950 debt tokens
				;({ 0: firstRedemptionHint, 1: partialRedemptionHintNewICR } = await vesselManagerOperations.getRedemptionHints(
					erc20.address,
					_950_,
					price,
					0
				))
				const { 0: upperPartialRedemptionHint_3, 1: lowerPartialRedemptionHint_3 } =
					await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNewICR, graham, graham)

				await adminContract.setWhitelistedRedeemer(graham, true)
				const redemption_3 = await vesselManagerOperations.redeemCollateral(
					erc20.address,
					_950_,
					firstRedemptionHint,
					upperPartialRedemptionHint_3,
					lowerPartialRedemptionHint_3,
					partialRedemptionHintNewICR,
					0,
					th._100pct,
					{ from: graham }
				)
				assert.isTrue(redemption_3.receipt.status)

				// 950 debt tokens redeemed = expect $950 worth of collateral removed
				const activePoolBalance3 = (await activePool.getAssetBalance(erc20.address)).toString()
				const expectedActivePoolBalance3 = activePoolBalance2.sub(calcSoftnedAmount(toBN(_950_), price))
				assert.equal(activePoolBalance3.toString(), expectedActivePoolBalance3.toString())
			})

			// it doesn’t make much sense as there’s now min debt enforced and at least one vessel must remain active
			// the only way to test it is before any vessel is opened
			it("redeemCollateral(): reverts if there is zero outstanding system debt", async () => {
				// --- SETUP --- illegally mint TRI to Bob
				await debtToken.unprotectedMint(bob, dec(100, 18))

				assert.equal(await debtToken.balanceOf(bob), dec(100, 18))

				const price = await priceFeed.getPrice(erc20.address)
				// Bob tries to redeem his illegally obtained TRI

				const { 0: firstRedemptionHint_Asset, 1: partialRedemptionHintNICR_Asset } =
					await vesselManagerOperations.getRedemptionHints(erc20.address, dec(100, 18), price, 0)

				const { 0: upperPartialRedemptionHint_Asset, 1: lowerPartialRedemptionHint_Asset } =
					await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNICR_Asset, bob, bob)
				let redeemError;
				try {
					await adminContract.setWhitelistedRedeemer(bob, true)
					await vesselManagerOperations.redeemCollateral(
						erc20.address,
						dec(100, 18),
						firstRedemptionHint_Asset,
						upperPartialRedemptionHint_Asset,
						lowerPartialRedemptionHint_Asset,
						partialRedemptionHintNICR_Asset,
						0,
						th._100pct,
						{ from: bob }
					)
				} catch (error) {
					redeemError = error;
				}
				assert.include(redeemError.message, "VM Exception while processing transaction")
			})

			it("redeemCollateral(): reverts if caller's tries to redeem more than the outstanding system debt", async () => {
				// --- SETUP --- illegally mint TRI to Bob
				await debtToken.unprotectedMint(bob, "202000000000000000000")

				assert.equal(await debtToken.balanceOf(bob), "202000000000000000000")

				const { totalDebt: C_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(1000, 16)),
					extraTRIAmount: dec(40, 18),
					extraParams: { from: carol },
				})
				const { totalDebt: D_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(1000, 16)),
					extraTRIAmount: dec(40, 18),
					extraParams: { from: dennis },
				})

				const totalDebt_Asset = C_totalDebt_Asset.add(D_totalDebt_Asset)

				th.assertIsApproximatelyEqual((await activePool.getDebtTokenBalance(erc20.address)).toString(), totalDebt_Asset)

				const price = await priceFeed.getPrice(erc20.address)

				const { 0: firstRedemptionHint_Asset, 1: partialRedemptionHintNICR_Asset } =
					await vesselManagerOperations.getRedemptionHints(erc20.address, "101000000000000000000", price, 0)

				const { 0: upperPartialRedemptionHint_Asset, 1: lowerPartialRedemptionHint_Asset } =
					await sortedVessels.findInsertPosition(erc20.address, partialRedemptionHintNICR_Asset, bob, bob)

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// Bob attempts to redeem his ill-gotten 101 TRI, from a system that has 100 TRI outstanding debt

				try {
					const redemptionTx_Asset = await vesselManagerOperations.redeemCollateral(
						erc20.address,
						totalDebt_Asset.add(toBN(dec(100, 18))),
						firstRedemptionHint_Asset,
						upperPartialRedemptionHint_Asset,
						lowerPartialRedemptionHint_Asset,
						partialRedemptionHintNICR_Asset,
						0,
						th._100pct,
						{ from: bob }
					)
				} catch (error) {
					assert.include(error.message, "VM Exception while processing transaction")
				}
			})

			// Redemption fees
			it("redeemCollateral(): a redemption made when base rate is zero increases the base rate", async () => {
				await adminContract.setRedemptionBaseFeeEnabled(erc20.address, true)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				const A_balanceBefore = await debtToken.balanceOf(A)

				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				// Check baseRate is now non-zero
				assert.isTrue((await vesselManager.baseRate(erc20.address)).gt(toBN("0")))
			})

			it("redeemCollateral(): a redemption made when redemption base fee is disabled keeps the base rate at 0", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				const A_balanceBefore = await debtToken.balanceOf(A)

				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				assert.equal(await vesselManager.baseRate(erc20.address), "0")
			})

			it("redeemCollateral(): a redemption made when base rate is non-zero increases the base rate, for negligible time passed", async () => {
				await adminContract.setRedemptionBaseFeeEnabled(erc20.address, true)
				// time fast-forwards 1 year
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const A_balanceBefore = await debtToken.balanceOf(A)
				const B_balanceBefore = await debtToken.balanceOf(B)

				// A redeems 10 TRI
				const redemptionTx_A_Asset = await th.redeemCollateralAndGetTxObject(
					A,
					contracts.core,
					dec(10, 18),
					erc20.address
				)
				const timeStamp_A_Asset = await th.getTimestampFromTx(redemptionTx_A_Asset, web3)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				// Check baseRate is now non-zero

				const baseRate_1_Asset = await vesselManager.baseRate(erc20.address)
				assert.isTrue(baseRate_1_Asset.gt(toBN("0")))

				// B redeems 10 TRI

				const redemptionTx_B_Asset = await th.redeemCollateralAndGetTxObject(
					B,
					contracts.core,
					dec(10, 18),
					erc20.address
				)
				const timeStamp_B_Asset = await th.getTimestampFromTx(redemptionTx_B_Asset, web3)

				// Check B's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

				// Check negligible time difference (< 1 minute) between txs
				assert.isTrue(Number(timeStamp_B_Asset) - Number(timeStamp_A_Asset) < 60)

				const baseRate_2_Asset = await vesselManager.baseRate(erc20.address)

				// Check baseRate has again increased
				assert.isTrue(baseRate_2_Asset.gt(baseRate_1_Asset))
			})

			it("redeemCollateral(): a redemption made when base fee is disabled keeps the base rate at 0, for negligible time passed", async () => {
				// time fast-forwards 1 year
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const A_balanceBefore = await debtToken.balanceOf(A)
				const B_balanceBefore = await debtToken.balanceOf(B)

				// A redeems 10 TRI
				const redemptionTx_A_Asset = await th.redeemCollateralAndGetTxObject(
					A,
					contracts.core,
					dec(10, 18),
					erc20.address
				)
				const timeStamp_A_Asset = await th.getTimestampFromTx(redemptionTx_A_Asset, web3)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				// B redeems 10 TRI

				const redemptionTx_B_Asset = await th.redeemCollateralAndGetTxObject(
					B,
					contracts.core,
					dec(10, 18),
					erc20.address
				)
				const timeStamp_B_Asset = await th.getTimestampFromTx(redemptionTx_B_Asset, web3)

				// Check B's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

				// Check negligible time difference (< 1 minute) between txs
				assert.isTrue(Number(timeStamp_B_Asset) - Number(timeStamp_A_Asset) < 60)

				assert.equal(await vesselManager.baseRate(erc20.address), "0")
			})

			it("redeemCollateral(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation [ @skip-on-coverage ]", async () => {
				await adminContract.setRedemptionBaseFeeEnabled(erc20.address, true)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				const A_balanceBefore = await debtToken.balanceOf(A)

				// A redeems 10 TRI
				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(A_balanceBefore.sub(await debtToken.balanceOf(A)).toString(), toBN(dec(10, 18)).toString())

				// Check baseRate is now non-zero

				const baseRate_1_Asset = await vesselManager.baseRate(erc20.address)
				assert.isTrue(baseRate_1_Asset.gt(toBN("0")))

				const lastFeeOpTime_1_Asset = await vesselManager.lastFeeOperationTime(erc20.address)

				// 45 seconds pass
				await th.fastForwardTime(45, web3.currentProvider)

				// Borrower A triggers a fee
				await th.redeemCollateral(A, contracts.core, dec(1, 18), erc20.address)

				const lastFeeOpTime_2_Asset = await vesselManager.lastFeeOperationTime(erc20.address)

				// Check that the last fee operation time did not update, as borrower A's 2nd redemption occured
				// since before minimum interval had passed
				assert.isTrue(lastFeeOpTime_2_Asset.eq(lastFeeOpTime_1_Asset))

				// 15 seconds passes
				await th.fastForwardTime(15, web3.currentProvider)

				// Check that now, at least one hour has passed since lastFeeOpTime_1
				const timeNow = await th.getLatestBlockTimestamp(web3)
				assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1_Asset).gte(3600))

				// Borrower A triggers a fee
				await th.redeemCollateral(A, contracts.core, dec(1, 18), erc20.address)

				const lastFeeOpTime_3_Asset = await vesselManager.lastFeeOperationTime(erc20.address)

				// Check that the last fee operation time DID update, as A's 2rd redemption occured
				// after minimum interval had passed
				assert.isTrue(lastFeeOpTime_3_Asset.gt(lastFeeOpTime_1_Asset))
			})

			it("redeemCollateral(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation and base fee rate is disabled [ @skip-on-coverage ]", async () => {
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				const A_balanceBefore = await debtToken.balanceOf(A)

				// A redeems 10 TRI
				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(A_balanceBefore.sub(await debtToken.balanceOf(A)).toString(), toBN(dec(10, 18)).toString())

				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const lastFeeOpTime_1_Asset = await vesselManager.lastFeeOperationTime(erc20.address)

				// 45 seconds pass
				await th.fastForwardTime(45, web3.currentProvider)

				// Borrower A triggers a fee
				await th.redeemCollateral(A, contracts.core, dec(1, 18), erc20.address)

				const lastFeeOpTime_2_Asset = await vesselManager.lastFeeOperationTime(erc20.address)

				// Check that the last fee operation time did not update, as borrower A's 2nd redemption occured
				// since before minimum interval had passed
				assert.isTrue(lastFeeOpTime_2_Asset.eq(lastFeeOpTime_1_Asset))

				// 15 seconds passes
				await th.fastForwardTime(15, web3.currentProvider)

				// Check that now, at least one hour has passed since lastFeeOpTime_1
				const timeNow = await th.getLatestBlockTimestamp(web3)
				assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1_Asset).gte(3600))

				// Borrower A triggers a fee
				await th.redeemCollateral(A, contracts.core, dec(1, 18), erc20.address)

				const lastFeeOpTime_3_Asset = await vesselManager.lastFeeOperationTime(erc20.address)

				// Check that the last fee operation time DID update, as A's 2rd redemption occured
				// after minimum interval had passed
				assert.isTrue(lastFeeOpTime_3_Asset.gt(lastFeeOpTime_1_Asset))
			})

			it("redeemCollateral(): a redemption made at zero base rate send a non-zero ETHFee to treasury contract", async () => {
				await adminContract.setRedemptionBaseFeeEnabled(erc20.address, true)
				// time fast-forwards 1 year,
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const treasuryBalanceBefore = await erc20.balanceOf(treasury)
				const A_balanceBefore = await debtToken.balanceOf(A)

				// A redeems 10 TRI
				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				// Check baseRate is now non-zero

				const baseRate_1_Asset = await vesselManager.baseRate(erc20.address)
				assert.isTrue(baseRate_1_Asset.gt(toBN("0")))

				const treasuryBalanceAfter = await erc20.balanceOf(treasury)
				assert.isTrue(treasuryBalanceAfter.gt(treasuryBalanceBefore))
			})

			it("redeemCollateral(): a redemption made at zero base rate send a non-zero ETHFee to treasury contract while base fee rate is disabled", async () => {
				// time fast-forwards 1 year,
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const treasuryBalanceBefore = await erc20.balanceOf(treasury)
				const A_balanceBefore = await debtToken.balanceOf(A)

				// A redeems 10 TRI
				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const treasuryBalanceAfter = await erc20.balanceOf(treasury)
				assert.isTrue(treasuryBalanceAfter.gt(treasuryBalanceBefore))
			})

			it("redeemCollateral(): a redemption made at a non-zero base rate send a non-zero ETHFee to treasury contract", async () => {
				await adminContract.setRedemptionBaseFeeEnabled(erc20.address, true)
				// time fast-forwards 1 year
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const A_balanceBefore = await debtToken.balanceOf(A)
				const B_balanceBefore = await debtToken.balanceOf(B)

				// A redeems 10 TRI
				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				// Check baseRate is now non-zero

				const baseRate_1_Asset = await vesselManager.baseRate(erc20.address)
				assert.isTrue(baseRate_1_Asset.gt(toBN("0")))

				const treasuryBalanceBefore = await erc20.balanceOf(treasury)

				// B redeems 10 TRI
				await th.redeemCollateral(B, contracts.core, dec(10, 18), erc20.address)

				// Check B's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

				const treasuryBalanceAfter = await erc20.balanceOf(treasury)

				assert.isTrue(treasuryBalanceAfter.gt(treasuryBalanceBefore))
			})

			it("redeemCollateral(): a redemption made at a non-zero base rate send a non-zero ETHFee to treasury contract while base rate fee is disabled", async () => {
				// time fast-forwards 1 year
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const A_balanceBefore = await debtToken.balanceOf(A)
				const B_balanceBefore = await debtToken.balanceOf(B)

				// A redeems 10 TRI
				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const treasuryBalanceBefore = await erc20.balanceOf(treasury)

				// B redeems 10 TRI
				await th.redeemCollateral(B, contracts.core, dec(10, 18), erc20.address)

				// Check B's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

				const treasuryBalanceAfter = await erc20.balanceOf(treasury)

				assert.isTrue(treasuryBalanceAfter.gt(treasuryBalanceBefore))
			})

			it("redeemCollateral(): a redemption made at a non-zero base rate increases treasury balance", async () => {
				await adminContract.setRedemptionBaseFeeEnabled(erc20.address, true)

				// time fast-forwards 1 year
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const A_balanceBefore = await debtToken.balanceOf(A)
				const B_balanceBefore = await debtToken.balanceOf(B)

				// A redeems 10 TRI
				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				// Check baseRate is now non-zero

				const baseRate_1_Asset = await vesselManager.baseRate(erc20.address)
				assert.isTrue(baseRate_1_Asset.gt(toBN("0")))

				const treasuryBalanceBefore = await erc20.balanceOf(treasury)

				// B redeems 10 TRI
				await th.redeemCollateral(B, contracts.core, dec(10, 18), erc20.address)

				// Check B's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

				const treasuryBalanceAfter = await erc20.balanceOf(treasury)

				assert.isTrue(treasuryBalanceAfter.gt(treasuryBalanceBefore))
			})

			it("redeemCollateral(): a redemption made at a non-zero base rate increases treasury balance while base fee rate is disabled", async () => {
				// time fast-forwards 1 year
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				// Check baseRate == 0
				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const A_balanceBefore = await debtToken.balanceOf(A)
				const B_balanceBefore = await debtToken.balanceOf(B)

				// A redeems 10 TRI
				await th.redeemCollateral(A, contracts.core, dec(10, 18), erc20.address)

				// Check A's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

				assert.equal(await vesselManager.baseRate(erc20.address), "0")

				const treasuryBalanceBefore = await erc20.balanceOf(treasury)

				// B redeems 10 TRI
				await th.redeemCollateral(B, contracts.core, dec(10, 18), erc20.address)

				// Check B's balance has decreased by 10 TRI
				assert.equal(await debtToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

				const treasuryBalanceAfter = await erc20.balanceOf(treasury)

				assert.isTrue(treasuryBalanceAfter.gt(treasuryBalanceBefore))
			})

			it.skip("redeemCollateral(): a redemption sends the remainder collateral (CollDrawn - CollFee) to the redeemer", async () => {
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
				const { totalDebt: W_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraParams: { from: whale },
				})
				const { totalDebt: A_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				const { totalDebt: B_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				const { totalDebt: C_totalDebt } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt)

				// Confirm baseRate before redemption is 0
				const baseRate = await vesselManager.baseRate(erc20.address)
				assert.equal(baseRate, "0")

				// Check total debtToken supply
				const debtTokensOnActivePool = await activePool.getDebtTokenBalance(erc20.address)
				const debtTokensOnDefaultPool = await defaultPool.getDebtTokenBalance(erc20.address)

				const totalDebtTokenSupply = debtTokensOnActivePool.add(debtTokensOnDefaultPool)
				th.assertIsApproximatelyEqual(totalDebtTokenSupply, totalDebt)

				const A_balanceBefore = toBN(await erc20.balanceOf(A))

				// A redeems $9
				const redemptionAmount = toBN(dec(9, 18))
				await th.redeemCollateral(A, contracts.core, redemptionAmount, erc20.address)

				// At Coll:USD price of 200:
				// collDrawn = (9 / 200) = 0.045 -> 0.04365 after softening
				// redemptionFee = (0.005 + (1/2) *(9/260)) * assetDrawn = 0.00100384615385
				// assetRemainder = 0.045 - 0.001003... = 0.0439961538462

				const A_balanceAfter = toBN(await erc20.balanceOf(A))

				// check A's asset balance has increased by 0.045
				const price = await priceFeed.getPrice(erc20.address)
				const assetDrawn = calcSoftnedAmount(redemptionAmount, price)

				const A_balanceDiff = A_balanceAfter.sub(A_balanceBefore)
				const redemptionFee = toBN(dec(5, 15))
					.add(redemptionAmount.mul(mv._1e18BN).div(totalDebt).div(toBN(2)))
					.mul(assetDrawn)
					.div(mv._1e18BN)
				const expectedDiff = assetDrawn.sub(redemptionFee)

				console.log(`${f(assetDrawn)} -> assetDrawn`)
				console.log(`${f(redemptionFee)} -> redemptionFee`)
				console.log(`${f(A_balanceDiff)} -> balanceDiff`)
				console.log(`${f(expectedDiff)} -> expectedDiff`)
				console.log(`${f(A_balanceDiff.sub(expectedDiff))} -> error`)

				th.assertIsApproximatelyEqual(A_balanceDiff, expectedDiff, 100_000)
			})

			it("redeemCollateral(): a full redemption (leaving vessel with 0 debt), closes the vessel", async () => {
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				const { netDebt: W_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraTRIAmount: dec(10000, 18),
					extraParams: { from: whale },
				})
				const { netDebt: A_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				const { netDebt: B_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				const { netDebt: C_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})
				const { netDebt: D_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(280, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: D },
				})

				const redemptionAmount_Asset = A_netDebt_Asset.add(B_netDebt_Asset)
					.add(C_netDebt_Asset)
					.add(toBN(dec(10, 18)))

				const A_balanceBefore_Asset = toBN(await erc20.balanceOf(A))
				const B_balanceBefore_Asset = toBN(await erc20.balanceOf(B))
				const C_balanceBefore_Asset = toBN(await erc20.balanceOf(C))

				// whale redeems 360 TRI.  Expect this to fully redeem A, B, C, and partially redeem D.
				await th.redeemCollateral(whale, contracts.core, redemptionAmount_Asset, erc20.address)

				// Check A, B, C have been closed

				assert.isFalse(await sortedVessels.contains(erc20.address, A))
				assert.isFalse(await sortedVessels.contains(erc20.address, B))
				assert.isFalse(await sortedVessels.contains(erc20.address, C))

				// Check D remains active
				assert.isTrue(await sortedVessels.contains(erc20.address, D))
			})

			const redeemCollateral3Full1Partial = async () => {
				// time fast-forwards 1 year
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

				const { netDebt: W_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraTRIAmount: dec(10000, 18),
					extraParams: { from: whale },
				})
				const { netDebt: A_netDebt_Asset, collateral: A_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				const { netDebt: B_netDebt_Asset, collateral: B_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				const { netDebt: C_netDebt_Asset, collateral: C_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})
				const { netDebt: D_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(280, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: D },
				})

				const redemptionAmount_Asset = A_netDebt_Asset.add(B_netDebt_Asset)
					.add(C_netDebt_Asset)
					.add(toBN(dec(10, 18)))

				const A_balanceBefore_Asset = toBN(await erc20.balanceOf(A))
				const B_balanceBefore_Asset = toBN(await erc20.balanceOf(B))
				const C_balanceBefore_Asset = toBN(await erc20.balanceOf(C))
				const D_balanceBefore_Asset = toBN(await erc20.balanceOf(D))

				const A_collBefore_Asset = await vesselManager.getVesselColl(erc20.address, A)
				const B_collBefore_Asset = await vesselManager.getVesselColl(erc20.address, B)
				const C_collBefore_Asset = await vesselManager.getVesselColl(erc20.address, C)
				const D_collBefore_Asset = await vesselManager.getVesselColl(erc20.address, D)

				// Confirm baseRate before redemption is 0

				const baseRate_Asset = await vesselManager.baseRate(erc20.address)
				assert.equal(baseRate_Asset, "0")

				// whale redeems TRI.  Expect this to fully redeem A, B, C, and partially redeem D.
				await th.redeemCollateral(whale, contracts.core, redemptionAmount_Asset, erc20.address)

				// Check A, B, C have been closed

				assert.isFalse(await sortedVessels.contains(erc20.address, A))
				assert.isFalse(await sortedVessels.contains(erc20.address, B))
				assert.isFalse(await sortedVessels.contains(erc20.address, C))

				// Check D stays active
				assert.isTrue(await sortedVessels.contains(erc20.address, D))

				/*
    At ETH:USD price of 200, with full redemptions from A, B, C:

    ETHDrawn from A = 100/200 = 0.5 ETH --> Surplus = (1-0.5) = 0.5
    ETHDrawn from B = 120/200 = 0.6 ETH --> Surplus = (1-0.6) = 0.4
    ETHDrawn from C = 130/200 = 0.65 ETH --> Surplus = (2-0.65) = 1.35
    */

				const A_balanceAfter_Asset = toBN(await erc20.balanceOf(A))
				const B_balanceAfter_Asset = toBN(await erc20.balanceOf(B))
				const C_balanceAfter_Asset = toBN(await erc20.balanceOf(C))
				const D_balanceAfter_Asset = toBN(await erc20.balanceOf(D))

				// Check A, B, C’s vessel collateral balance is zero (fully redeemed-from vessels)

				const A_collAfter_Asset = await vesselManager.getVesselColl(erc20.address, A)
				const B_collAfter_Asset = await vesselManager.getVesselColl(erc20.address, B)
				const C_collAfter_Asset = await vesselManager.getVesselColl(erc20.address, C)

				assert.isTrue(A_collAfter_Asset.eq(toBN(0)))
				assert.isTrue(B_collAfter_Asset.eq(toBN(0)))
				assert.isTrue(C_collAfter_Asset.eq(toBN(0)))

				// check D's vessel collateral balances have decreased (the partially redeemed-from vessel)

				const D_collAfter_Asset = await vesselManager.getVesselColl(erc20.address, D)
				assert.isTrue(D_collAfter_Asset.lt(D_collBefore_Asset))

				// Check A, B, C (fully redeemed-from vessels), and D's (the partially redeemed-from vessel) balance has not changed

				assert.isTrue(A_balanceAfter_Asset.eq(A_balanceBefore_Asset))
				assert.isTrue(B_balanceAfter_Asset.eq(B_balanceBefore_Asset))
				assert.isTrue(C_balanceAfter_Asset.eq(C_balanceBefore_Asset))
				assert.isTrue(D_balanceAfter_Asset.eq(D_balanceBefore_Asset))

				// D is not closed, so cannot open vessel
				await assertRevert(
					borrowerOperations.openVessel(erc20.address, dec(10, 18), 0, D, D, {
						from: D,
					}),
					"BorrowerOps: Vessel is active"
				)

				return {
					A_netDebt_Asset,
					A_coll_Asset,
					B_netDebt_Asset,
					B_coll_Asset,
					C_netDebt_Asset,
					C_coll_Asset,
				}
			}

			it("redeemCollateral(): emits correct debt and coll values in each redeemed vessel's VesselUpdated event", async () => {
				// VesselUpdated is emitted by the VM contract - and not VMRedemptions - so it isn't captured/decoded in the receipt tx
				const { netDebt: W_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(20, 18)),
					extraTRIAmount: dec(10000, 18),
					extraParams: { from: whale },
				})
				const { netDebt: A_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				const { netDebt: B_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				const { netDebt: C_netDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})
				const { totalDebt: D_totalDebt_Asset, collateral: D_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(280, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: D },
				})

				const partialAmount = toBN(dec(15, 18))
				const redemptionAmount_Asset = A_netDebt_Asset.add(B_netDebt_Asset).add(C_netDebt_Asset).add(partialAmount)

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// whale redeems TRI.  Expect this to fully redeem A, B, C, and partially redeem 15 TRI from D.

				const redemptionTx_Asset = await th.redeemCollateralAndGetTxObject(
					whale,
					contracts.core,
					redemptionAmount_Asset,
					erc20.address,
					th._100pct
					// { gasPrice: 0 }
				)

				// Check A, B, C have been closed

				assert.isFalse(await sortedVessels.contains(erc20.address, A))
				assert.isFalse(await sortedVessels.contains(erc20.address, B))
				assert.isFalse(await sortedVessels.contains(erc20.address, C))

				// Check D stays active
				assert.isTrue(await sortedVessels.contains(erc20.address, D))

				//		Skip this part, as the VesselUpdated event is emitted by a nested contract call and is no longer returned by the th

				// 		const vesselUpdatedEvents_Asset = th.getAllEventsByName(redemptionTx_Asset, "VesselUpdated")

				// 		// Get each vessel's emitted debt and coll

				// 		const [A_emittedDebt_Asset, A_emittedColl_Asset] = th.getDebtAndCollFromVesselUpdatedEvents(
				// 			vesselUpdatedEvents_Asset,
				// 			A
				// 		)
				// 		const [B_emittedDebt_Asset, B_emittedColl_Asset] = th.getDebtAndCollFromVesselUpdatedEvents(
				// 			vesselUpdatedEvents_Asset,
				// 			B
				// 		)
				// 		const [C_emittedDebt_Asset, C_emittedColl_Asset] = th.getDebtAndCollFromVesselUpdatedEvents(
				// 			vesselUpdatedEvents_Asset,
				// 			C
				// 		)
				// 		const [D_emittedDebt_Asset, D_emittedColl_Asset] = th.getDebtAndCollFromVesselUpdatedEvents(
				// 			vesselUpdatedEvents_Asset,
				// 			D
				// 		)

				// 		// Expect A, B, C to have 0 emitted debt and coll, since they were closed

				// 		assert.equal(A_emittedDebt_Asset, "0")
				// 		assert.equal(A_emittedColl_Asset, "0")
				// 		assert.equal(B_emittedDebt_Asset, "0")
				// 		assert.equal(B_emittedColl_Asset, "0")
				// 		assert.equal(C_emittedDebt_Asset, "0")
				// 		assert.equal(C_emittedColl_Asset, "0")

				// 		/* Expect D to have lost 15 debt and (at ETH price of 200) 15/200 = 0.075 ETH.
				// So, expect remaining debt = (85 - 15) = 70, and remaining ETH = 1 - 15/200 = 0.925 remaining. */
				// 		const price = await priceFeed.getPrice(erc20.address)

				// 		th.assertIsApproximatelyEqual(D_emittedDebt_Asset, D_totalDebt_Asset.sub(partialAmount))
				// 		th.assertIsApproximatelyEqual(D_emittedColl_Asset, D_coll_Asset.sub(partialAmount.mul(mv._1e18BN).div(price)))
			})

			it("redeemCollateral(): a redemption that closes a vessel leaves the vessel's surplus (collateral - collateral drawn) available for the vessel owner to claim", async () => {
				const { A_netDebt_Asset, A_coll_Asset, B_netDebt_Asset, B_coll_Asset, C_netDebt_Asset, C_coll_Asset } =
					await redeemCollateral3Full1Partial()

				const A_balanceBefore_Asset = toBN(await erc20.balanceOf(A))
				const B_balanceBefore_Asset = toBN(await erc20.balanceOf(B))
				const C_balanceBefore_Asset = toBN(await erc20.balanceOf(C))

				// CollSurplusPool endpoint cannot be called directly
				await assertRevert(
					collSurplusPool.claimColl(erc20.address, A),
					"CollSurplusPool: Caller is not Borrower Operations"
				)

				await borrowerOperations.claimCollateral(erc20.address, { from: A })
				await borrowerOperations.claimCollateral(erc20.address, { from: B })
				await borrowerOperations.claimCollateral(erc20.address, { from: C })

				const A_balanceAfter_Asset = toBN(await erc20.balanceOf(A))
				const B_balanceAfter_Asset = toBN(await erc20.balanceOf(B))
				const C_balanceAfter_Asset = toBN(await erc20.balanceOf(C))

				const price = await priceFeed.getPrice(erc20.address)

				const A_balanceExpected_Asset = A_balanceBefore_Asset.add(
					A_coll_Asset.sub(calcSoftnedAmount(A_netDebt_Asset, price))
				)
				const B_balanceExpected_Asset = B_balanceBefore_Asset.add(
					B_coll_Asset.sub(calcSoftnedAmount(B_netDebt_Asset, price))
				)
				const C_balanceExpected_Asset = C_balanceBefore_Asset.add(
					C_coll_Asset.sub(calcSoftnedAmount(C_netDebt_Asset, price))
				)

				th.assertIsApproximatelyEqual(A_balanceAfter_Asset, A_balanceExpected_Asset)
				th.assertIsApproximatelyEqual(B_balanceAfter_Asset, B_balanceExpected_Asset)
				th.assertIsApproximatelyEqual(C_balanceAfter_Asset, C_balanceExpected_Asset)
			})

			it("redeemCollateral(): a redemption that closes a vessel leaves the vessel's surplus (collateral - collateral drawn) available for the vessel owner after re-opening vessel", async () => {
				const {
					A_netDebt_Asset,
					A_coll_Asset: A_collBefore_Asset,
					B_netDebt_Asset,
					B_coll_Asset: B_collBefore_Asset,
					C_netDebt_Asset,
					C_coll_Asset: C_collBefore_Asset,
				} = await redeemCollateral3Full1Partial()

				const price = await priceFeed.getPrice(erc20.address)

				const A_surplus_Asset = A_collBefore_Asset.sub(calcSoftnedAmount(A_netDebt_Asset, price))
				const B_surplus_Asset = B_collBefore_Asset.sub(calcSoftnedAmount(B_netDebt_Asset, price))
				const C_surplus_Asset = C_collBefore_Asset.sub(calcSoftnedAmount(C_netDebt_Asset, price))

				const { collateral: A_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: A },
				})
				const { collateral: B_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(190, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: B },
				})
				const { collateral: C_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(180, 16)),
					extraTRIAmount: dec(100, 18),
					extraParams: { from: C },
				})

				const A_collAfter_Asset = await vesselManager.getVesselColl(erc20.address, A)
				const B_collAfter_Asset = await vesselManager.getVesselColl(erc20.address, B)
				const C_collAfter_Asset = await vesselManager.getVesselColl(erc20.address, C)

				assert.isTrue(A_collAfter_Asset.eq(A_coll_Asset))
				assert.isTrue(B_collAfter_Asset.eq(B_coll_Asset))
				assert.isTrue(C_collAfter_Asset.eq(C_coll_Asset))

				const A_balanceBefore_Asset = toBN(await erc20.balanceOf(A))
				const B_balanceBefore_Asset = toBN(await erc20.balanceOf(B))
				const C_balanceBefore_Asset = toBN(await erc20.balanceOf(C))

				await borrowerOperations.claimCollateral(erc20.address, { from: A })
				await borrowerOperations.claimCollateral(erc20.address, { from: B })
				await borrowerOperations.claimCollateral(erc20.address, { from: C })

				const A_balanceAfter_Asset = toBN(await erc20.balanceOf(A))
				const B_balanceAfter_Asset = toBN(await erc20.balanceOf(B))
				const C_balanceAfter_Asset = toBN(await erc20.balanceOf(C))

				th.assertIsApproximatelyEqual(A_balanceAfter_Asset, A_balanceBefore_Asset.add(A_surplus_Asset))
				th.assertIsApproximatelyEqual(B_balanceAfter_Asset, B_balanceBefore_Asset.add(B_surplus_Asset))
				th.assertIsApproximatelyEqual(C_balanceAfter_Asset, C_balanceBefore_Asset.add(C_surplus_Asset))
			})

			it("redeemCollateral(): reverts if fee eats up all returned collateral", async () => {
				// --- SETUP ---
				await adminContract.setRedemptionBaseFeeEnabled(erc20.address, true)

				const { TRIAmount: TRIAmount_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(200, 16)),
					extraTRIAmount: dec(1, 24),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: bob },
				})

				const price = await priceFeed.getPrice(erc20.address)

				// --- TEST ---

				// skip bootstrapping phase
				await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

				// keep redeeming until we get the base rate to the ceiling of 100%

				for (let i = 0; i < 2; i++) {
					// Find hints for redeeming
					const { 0: firstRedemptionHint_Asset, 1: partialRedemptionHintNICR_Asset } =
						await vesselManagerOperations.getRedemptionHints(erc20.address, TRIAmount_Asset, price, 0)

					await adminContract.setWhitelistedRedeemer(alice, true)
					// Don't pay for gas, as it makes it easier to calculate the received Ether
					const redemptionTx_Asset = await vesselManagerOperations.redeemCollateral(
						erc20.address,
						TRIAmount_Asset,
						firstRedemptionHint_Asset,
						alice,
						alice,
						partialRedemptionHintNICR_Asset,
						0,
						th._100pct,
						{
							from: alice,
							// gasPrice: 0,
						}
					)

					await openVessel({
						asset: erc20.address,
						ICR: toBN(dec(150, 16)),
						extraParams: { from: bob },
					})
					await borrowerOperations.adjustVessel(
						erc20.address,
						TRIAmount_Asset.mul(mv._1e18BN).div(price),
						0,
						TRIAmount_Asset,
						true,
						alice,
						alice,
						{ from: alice }
					)
				}

				const { 0: firstRedemptionHint_Asset, 1: partialRedemptionHintNICR_Asset } =
					await vesselManagerOperations.getRedemptionHints(erc20.address, TRIAmount_Asset, price, 0)

				await assertRevert(
					vesselManagerOperations.redeemCollateral(
						erc20.address,
						TRIAmount_Asset,
						firstRedemptionHint_Asset,
						alice,
						alice,
						partialRedemptionHintNICR_Asset,
						0,
						th._100pct,
						{
							from: alice,
							// gasPrice: 0,
						}
					),
					"VesselManager: Fee would eat up all returned collateral"
				)
			})

			it('redeemCollateral(): reverts if redeemer is not whitelisted', async () =>{
				await assertRevert(
					vesselManagerOperations.redeemCollateral(
						erc20.address,
						dec(1, 18),
						ethers.constants.AddressZero,
						alice,
						alice,
						ethers.constants.AddressZero,
						0,
						th._100pct,
						{ from: alice }
					),
					'VesselManager: Redeemer is not whitelisted'
				)
			})
		})

		describe("Extras", async () => {
			// --- computeICR ---

			it("computeICR(): returns 0 if vessel's coll is worth 0", async () => {
				const price = 0
				const coll = dec(1, "ether")
				const debt = dec(100, 18)

				const ICR = (await vesselManager.computeICR(coll, debt, price)).toString()
				assert.equal(ICR, 0)
			})

			it("computeICR(): returns 2^256-1 for ETH:USD = 100, coll = 1 ETH, debt = 100 TRI", async () => {
				const price = dec(100, 18)
				const coll = dec(1, "ether")
				const debt = dec(100, 18)

				const ICR = (await vesselManager.computeICR(coll, debt, price)).toString()
				assert.equal(ICR, dec(1, 18))
			})

			it("computeICR(): returns correct ICR for ETH:USD = 100, coll = 200 ETH, debt = 30 TRI", async () => {
				const price = dec(100, 18)
				const coll = dec(200, "ether")
				const debt = dec(30, 18)

				const ICR = (await vesselManager.computeICR(coll, debt, price)).toString()
				assert.isAtMost(th.getDifference(ICR, "666666666666666666666"), 1000)
			})

			it("computeICR(): returns correct ICR for ETH:USD = 250, coll = 1350 ETH, debt = 127 TRI", async () => {
				const price = "250000000000000000000"
				const coll = "1350000000000000000000"
				const debt = "127000000000000000000"

				const ICR = await vesselManager.computeICR(coll, debt, price)
				assert.isAtMost(th.getDifference(ICR, "2657480314960630000000"), 1000000)
			})

			it("computeICR(): returns correct ICR for ETH:USD = 100, coll = 1 ETH, debt = 54321 TRI", async () => {
				const price = dec(100, 18)
				const coll = dec(1, "ether")
				const debt = "54321000000000000000000"

				const ICR = (await vesselManager.computeICR(coll, debt, price)).toString()
				assert.isAtMost(th.getDifference(ICR, "1840908672520756"), 1000)
			})

			it("computeICR(): returns 2^256-1 if vessel has non-zero coll and zero debt", async () => {
				const price = dec(100, 18)
				const coll = dec(1, "ether")
				const debt = 0

				const ICR = web3.utils.toHex(await vesselManager.computeICR(coll, debt, price))
				const maxBytes32 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
				assert.equal(ICR, maxBytes32)
			})
		})

		describe("Recovery Mode", async () => {
			// --- checkRecoveryMode ---

			//TCR < 150%
			it("checkRecoveryMode(): returns true when TCR < 150%", async () => {
				await priceFeed.setPrice(erc20.address, dec(100, 18))

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: bob },
				})

				await priceFeed.setPrice(erc20.address, "99999999999999999999")

				const TCR_Asset = await th.getTCR(contracts.core, erc20.address)

				assert.isTrue(TCR_Asset.lte(toBN("1500000000000000000")))

				assert.isTrue(await th.checkRecoveryMode(contracts.core, erc20.address))
			})

			// TCR == 150%
			it("checkRecoveryMode(): returns false when TCR == 150%", async () => {
				await priceFeed.setPrice(erc20.address, dec(100, 18))

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: bob },
				})

				const TCR_Asset = await th.getTCR(contracts.core, erc20.address)

				assert.equal(TCR_Asset, "1500000000000000000")

				assert.isFalse(await th.checkRecoveryMode(contracts.core, erc20.address))
			})

			// > 150%
			it("checkRecoveryMode(): returns false when TCR > 150%", async () => {
				await priceFeed.setPrice(erc20.address, dec(100, 18))

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: bob },
				})

				await priceFeed.setPrice(erc20.address, "100000000000000000001")

				const TCR_Asset = await th.getTCR(contracts.core, erc20.address)

				assert.isTrue(TCR_Asset.gte(toBN("1500000000000000000")))

				assert.isFalse(await th.checkRecoveryMode(contracts.core, erc20.address))
			})

			// check 0
			it("checkRecoveryMode(): returns false when TCR == 0", async () => {
				await priceFeed.setPrice(erc20.address, dec(100, 18))

				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: alice },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: bob },
				})

				await priceFeed.setPrice(erc20.address, 0)

				const TCR_Asset = (await th.getTCR(contracts.core, erc20.address)).toString()

				assert.equal(TCR_Asset, 0)

				assert.isTrue(await th.checkRecoveryMode(contracts.core, erc20.address))
			})
		})

		describe("Getters", async () => {
			it("getVesselColl(): returns coll", async () => {
				const { collateral: A_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: A },
				})
				const { collateral: B_coll_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: B },
				})

				assert.equal(await vesselManager.getVesselColl(erc20.address, A), A_coll_Asset.toString())
				assert.equal(await vesselManager.getVesselColl(erc20.address, B), B_coll_Asset.toString())
			})

			it("getVesselDebt(): returns debt", async () => {
				const { totalDebt: totalDebtA_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: A },
				})
				const { totalDebt: totalDebtB_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: B },
				})

				const A_Debt_Asset = await vesselManager.getVesselDebt(erc20.address, A)
				const B_Debt_Asset = await vesselManager.getVesselDebt(erc20.address, B)

				// Expect debt = requested + 0.5% fee + 50 (due to gas comp)

				assert.equal(A_Debt_Asset, totalDebtA_Asset.toString())
				assert.equal(B_Debt_Asset, totalDebtB_Asset.toString())
			})

			it("getVesselStatus(): returns status", async () => {
				const { totalDebt: B_totalDebt_Asset } = await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraParams: { from: B },
				})
				await openVessel({
					asset: erc20.address,
					ICR: toBN(dec(150, 16)),
					extraTRIAmount: B_totalDebt_Asset,
					extraParams: { from: A },
				})

				// to be able to repay:
				await debtToken.transfer(B, B_totalDebt_Asset, { from: A })

				await borrowerOperations.closeVessel(erc20.address, { from: B })

				const A_Status_Asset = await vesselManager.getVesselStatus(erc20.address, A)
				const B_Status_Asset = await vesselManager.getVesselStatus(erc20.address, B)
				const C_Status_Asset = await vesselManager.getVesselStatus(erc20.address, C)

				assert.equal(A_Status_Asset, "1") // active
				assert.equal(B_Status_Asset, "2") // closed by user
				assert.equal(C_Status_Asset, "0") // non-existent
			})
		})
	})
})

contract("Reset chain state", async accounts => {})

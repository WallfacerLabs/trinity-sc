const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const th = testHelpers.TestHelper
const { dec, toBN, assertRevert } = th

var contracts
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
	feeCollector = contracts.core.feeCollector
	gasPool = contracts.core.gasPool
	priceFeed = contracts.core.priceFeedTestnet
	sortedVessels = contracts.core.sortedVessels
	stabilityPool = contracts.core.stabilityPool
	vesselManager = contracts.core.vesselManager
	vesselManagerOperations = contracts.core.vesselManagerOperations
	shortTimelock = contracts.core.shortTimelock
	longTimelock = contracts.core.longTimelock
}

contract("Access Control: functions where the caller is restricted to Trinity contract(s)", async accounts => {
	const [alice, bob, treasury] = accounts

	before(async () => {
		await deploy(treasury, accounts.slice(0, 10))
		for (account of accounts.slice(0, 10)) {
			await openVessel({
				asset: erc20.address,
				extraTRIAmount: toBN(dec(20000, 18)),
				ICR: toBN(dec(2, 18)),
				extraParams: { from: account },
			})
		}
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

	describe("ActivePool", async accounts => {
		it("sendAsset(): reverts when called by an account that is not BO nor VesselM nor SP", async () => {
			// Attempt call from alice
			try {
				await activePool.sendAsset(erc20.address, alice, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is neither BorrowerOperations nor VesselManager nor StabilityPool")
			}
		})
		it("increaseDebt(): reverts when called by an account that is not BO nor VesselM", async () => {
			// Attempt call from alice
			try {
				await activePool.increaseDebt(erc20.address, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is not a Trinity contract")
			}
		})
		it("decreaseDebt(): reverts when called by an account that is not BO nor VesselM nor SP", async () => {
			// Attempt call from alice
			try {
				await activePool.decreaseDebt(erc20.address, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is neither BorrowerOperations nor VesselManager nor StabilityPool")
			}
		})
		it.skip("fallback(): reverts when called by an account that is not Borrower Operations nor Default Pool", async () => {
			// Attempt call from alice
			try {
				const txAlice = await web3.eth.sendTransaction({
					from: alice,
					to: activePool.address,
					value: 100,
				})
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, "ActivePool: Caller is neither BO nor Default Pool")
			}
		})
	})

	describe("DebtToken", async accounts => {
		it("mint(): reverts when called by an account that is not BorrowerOperations", async () => {
			// Attempt call from alice
			const txAlice = debtToken.mint(th.ZERO_ADDRESS, bob, 100, { from: alice })
			await th.assertRevert(txAlice, "Caller is not BorrowerOperations")
		})
		it("burn(): reverts when called by an account that is not BO nor VesselM nor SP", async () => {
			// Attempt call from alice
			try {
				const txAlice = await debtToken.burn(bob, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is neither BorrowerOperations nor VesselManager nor StabilityPool")
			}
		})
		it("sendToPool(): reverts when called by an account that is not StabilityPool", async () => {
			// Attempt call from alice
			try {
				const txAlice = await debtToken.sendToPool(bob, activePool.address, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				//assert.include(err.message, "Caller is not the StabilityPool")
			}
		})
		it("returnFromPool(): reverts when called by an account that is not VesselManager nor StabilityPool", async () => {
			// Attempt call from alice
			try {
				const txAlice = await debtToken.returnFromPool(activePool.address, bob, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is neither VesselManager nor StabilityPool")
			}
		})
	})
	describe("DefaultPool", async accounts => {
		it("sendAssetToActivePool(): reverts when called by an account that is not VesselManager", async () => {
			// Attempt call from alice
			try {
				await defaultPool.sendAssetToActivePool(erc20.address, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, "Caller is not the VesselManager")
			}
		})
		it("increaseDebt(): reverts when called by an account that is not VesselManager", async () => {
			// Attempt call from alice
			try {
				await defaultPool.increaseDebt(erc20.address, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, "Caller is not the VesselManager")
			}
		})
		it("decreaseDebt(): reverts when called by an account that is not VesselManager", async () => {
			// Attempt call from alice
			try {
				await defaultPool.decreaseDebt(erc20.address, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, "Caller is not the VesselManager")
			}
		})
		it.skip("fallback(): reverts when called by an account that is not the Active Pool", async () => {
			// Attempt call from alice
			try {
				const txAlice = await web3.eth.sendTransaction({
					from: alice,
					to: defaultPool.address,
					value: 100,
				})
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, "DefaultPool: Caller is not the ActivePool")
			}
		})
	})
	describe("SortedVessels", async accounts => {
		it("insert(): reverts when called by an account that is not BorrowerOps or VesselM", async () => {
			// Attempt call from alice
			try {
				await sortedVessels.insert(erc20.address, bob, "150000000000000000000", bob, bob, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, " Caller is neither BO nor VesselM")
			}
		})
		it("remove(): reverts when called by an account that is not VesselManager", async () => {
			// Attempt call from alice
			try {
				await sortedVessels.remove(erc20.address, bob, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, " Caller is not the VesselManager")
			}
		})

		it("reinsert(): reverts when called by an account that is neither BorrowerOps nor VesselManager", async () => {
			// Attempt call from alice
			try {
				await sortedVessels.reInsert(erc20.address, bob, "150000000000000000000", bob, bob, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, "Caller is neither BO nor VesselM")
			}
		})
	})
	describe("StabilityPool", async accounts => {
		it("offset(): reverts when called by an account that is not VesselManager", async () => {
			// Attempt call from alice
			try {
				txAlice = await stabilityPool.offset(100, erc20.address, 10, { from: alice })
				assert.fail(txAlice)
			} catch (err) {
				assert.include(err.message, "revert")
				// this is now a custom error
				// assert.include(err.message, "StabilityPool: Caller is not VesselManager")
			}
		})
		it.skip("fallback(): reverts when called by an account that is not the Active Pool", async () => {
			// Attempt call from alice
			try {
				await erc20.transfer(stabilityPool.address, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				assert.include(err.message, "StabilityPool: Caller is not ActivePool")
			}
		})
	})
	describe("VesselManager", async accounts => {
		it("closeVessel(): reverts when called by an account that is not BorrowerOperations", async () => {
			// Attempt call from alice
			try {
				await vesselManager.closeVessel(erc20.address, bob, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is not the BorrowerOperations contract")
			}
		})
		it("addVesselOwnerToArray(): reverts when called by an account that is not BorrowerOperations", async () => {
			// Attempt call from alice
			try {
				await vesselManager.addVesselOwnerToArray(erc20.address, bob, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is not the BorrowerOperations contract")
			}
		})
		it("setVesselStatus(): reverts when called by an account that is not BorrowerOperations", async () => {
			// Attempt call from alice
			try {
				await vesselManager.setVesselStatus(erc20.address, bob, 1, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is not the BorrowerOperations contract")
			}
		})
		it("increaseVesselColl(): reverts when called by an account that is not BorrowerOperations", async () => {
			// Attempt call from alice
			try {
				await vesselManager.increaseVesselColl(erc20.address, bob, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is not the BorrowerOperations contract")
			}
		})
		it("decreaseVesselColl(): reverts when called by an account that is not BorrowerOperations", async () => {
			// Attempt call from alice
			try {
				await vesselManager.decreaseVesselColl(erc20.address, bob, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is not the BorrowerOperations contract")
			}
		})
		it("increaseVesselDebt(): reverts when called by an account that is not BorrowerOperations", async () => {
			// Attempt call from alice
			try {
				await vesselManager.increaseVesselDebt(erc20.address, bob, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is not the BorrowerOperations contract")
			}
		})
		it("decreaseVesselDebt(): reverts when called by an account that is not BorrowerOperations", async () => {
			// Attempt call from alice
			try {
				await vesselManager.decreaseVesselDebt(erc20.address, bob, 100, { from: alice })
			} catch (err) {
				assert.include(err.message, "revert")
				// assert.include(err.message, "Caller is not the BorrowerOperations contract")
			}
		})
	})
})

contract("Reset chain state", async accounts => { })

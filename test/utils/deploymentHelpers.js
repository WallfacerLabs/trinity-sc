const ActivePool = artifacts.require("ActivePool")
const AdminContract = artifacts.require("AdminContract")
const BorrowerOperationsTester = artifacts.require("BorrowerOperationsTester")
const CollSurplusPool = artifacts.require("CollSurplusPool")
const DebtTokenTester = artifacts.require("DebtTokenTester")
const DebtTokenWhitelistedTester = artifacts.require("DebtTokenWhitelistedTester")
const DefaultPool = artifacts.require("DefaultPool")
const ERC20Test = artifacts.require("ERC20Test")
const GasPool = artifacts.require("GasPool")
const PriceFeedTestnet = artifacts.require("PriceFeedTestnet")
const SortedVessels = artifacts.require("SortedVessels")
const StabilityPoolTester = artifacts.require("StabilityPoolTester")
const Timelock = artifacts.require("Timelock")
const VesselManagerOperations = artifacts.require("VesselManagerOperations")
const VesselManagerTester = artifacts.require("VesselManagerTester")

const testHelpers = require("./testHelpers.js")
const th = testHelpers.TestHelper
const dec = th.dec

const EMPTY_ADDRESS = "0x" + "0".repeat(40)
const TIMELOCK_SHORT_DELAY = 86400 * 3
const TIMELOCK_LONG_DELAY = 86400 * 7

/**
 * Deploys Trinity's contracts to Hardhat TEST env
 */
class DeploymentHelper {
	static async deployTestContracts(treasuryAddress, distributorAddress, collateralMintingAccounts = []) {
		const core = await this._deployCoreContracts(treasuryAddress)
		await this._connectCoreContracts(core, treasuryAddress, distributorAddress)
		await this._connectGrvtContracts(core)

		for (const acc of collateralMintingAccounts) {
			const mintingValue = dec(100_000_000, 18)
			await core.erc20.mint(acc, mintingValue)
			await core.erc20B.mint(acc, mintingValue)
		}

		return { core }
	}

	static async _deployCoreContracts(treasuryAddress) {
		const activePool = await ActivePool.new()
		const adminContract = await AdminContract.new()
		const borrowerOperations = await BorrowerOperationsTester.new()
		const collSurplusPool = await CollSurplusPool.new()
		const defaultPool = await DefaultPool.new()
		const erc20 = await ERC20Test.new()
		const erc20B = await ERC20Test.new()
		const gasPool = await GasPool.new()
		const priceFeedTestnet = await PriceFeedTestnet.new()
		const sortedVessels = await SortedVessels.new()
		const stabilityPool = await StabilityPoolTester.new()
		const vesselManager = await VesselManagerTester.new()
		const vesselManagerOperations = await VesselManagerOperations.new()
		const shortTimelock = await Timelock.new(TIMELOCK_SHORT_DELAY, treasuryAddress)
		const longTimelock = await Timelock.new(TIMELOCK_LONG_DELAY, treasuryAddress)
		const debtToken = await DebtTokenTester.new()
		const debtTokenWhitelistedTester = await DebtTokenWhitelistedTester.new(debtToken.address)

		await erc20.setDecimals(18)
		await erc20B.setDecimals(18)

		const core = {
			activePool,
			adminContract,
			borrowerOperations,
			collSurplusPool,
			debtToken,
			debtTokenWhitelistedTester,
			defaultPool,
			gasPool,
			priceFeedTestnet,
			vesselManager,
			vesselManagerOperations,
			sortedVessels,
			stabilityPool,
			shortTimelock,
			longTimelock,
			erc20,
			erc20B,
		}

		await this._invokeInitializers(core)
		return core
	}

	/**
	 * Calls the initialize() function on the contracts that provide it; on deployment, that will be handled by upgrades.deployProxy()
	 */
	static async _invokeInitializers(contracts) {
		for (const key in contracts) {
			const contract = contracts[key]
			if (contract.initialize) {
				await contract.initialize()
			}
		}
	}

	/**
	 * Connects contracts to their dependencies.
	 */
	static async _connectCoreContracts(core, treasuryAddress, distributorAddress) {
		const setAddresses = async contract => {
			const addresses = [
				core.activePool.address,
				core.adminContract.address,
				core.borrowerOperations.address,
				core.collSurplusPool.address,
				core.debtToken.address,
				core.defaultPool.address,
				distributorAddress,
				core.gasPool.address,
				core.priceFeedTestnet.address,
				core.sortedVessels.address,
				core.stabilityPool.address,
				core.shortTimelock.address,
				treasuryAddress,
				core.vesselManager.address,
				core.vesselManagerOperations.address,
			]
			for (const [i, addr] of addresses.entries()) {
				if (!addr || addr == EMPTY_ADDRESS) {
					throw new Error(`setAddresses :: Invalid address for index ${i}`)
				}
			}
			await contract.setAddresses(addresses)
		}
		for (const key in core) {
			const contract = core[key]
			if (contract.setAddresses && contract.isAddressSetupInitialized) {
				await setAddresses(contract)
			}
		}
		await core.debtToken.setAddresses(
			core.borrowerOperations.address,
			core.stabilityPool.address,
			core.vesselManager.address
		)

		await core.priceFeedTestnet.setPrice(core.erc20.address, dec(200, "ether"))
		await core.priceFeedTestnet.setPrice(core.erc20B.address, dec(100, "ether"))

		await core.adminContract.addNewCollateral(EMPTY_ADDRESS, dec(30, 18), 18)
		await core.adminContract.addNewCollateral(core.erc20.address, dec(200, 18), 18)
		await core.adminContract.addNewCollateral(core.erc20B.address, dec(30, 18), 18)

		// Redemption are disabled by default; enable them for testing
		await core.adminContract.setRedemptionBlockTimestamp(EMPTY_ADDRESS, 0)
		await core.adminContract.setRedemptionBlockTimestamp(core.erc20.address, 0)
		await core.adminContract.setRedemptionBlockTimestamp(core.erc20B.address, 0)

		await core.adminContract.setIsActive(EMPTY_ADDRESS, true)
		await core.adminContract.setIsActive(core.erc20.address, true)
		await core.adminContract.setIsActive(core.erc20B.address, true)
	}

	/**
	 * Connects contracts to their dependencies.
	 */
	static async _connectGrvtContracts(core) {
		// Set configs (since the tests have been designed with it)
		const defaultFee = (0.005e18).toString() // 0.5%
		await core.adminContract.setCollateralParameters(
			EMPTY_ADDRESS,
			defaultFee, // borrowingFee
			(1.5e18).toString(), // ccr
			(1.1e18).toString(), // mcr
			dec(300, 18), // minNetDebt
			dec(1_000_000, 18), // mintCap
			defaultFee // redemptionFeeFloor
		)
		await core.adminContract.setCollateralParameters(
			core.erc20.address,
			defaultFee, // borrowingFee
			(1.5e18).toString(), // ccr
			(1.1e18).toString(), // mcr
			dec(1_800, 18), // minNetDebt
			dec(10_000_000_000, 18), // mintCap
			defaultFee // redemptionFeeFloor
		)
		await core.adminContract.setCollateralParameters(
			core.erc20B.address,
			defaultFee, // borrowingFee
			(1.5e18).toString(), // ccr
			(1.1e18).toString(), // mcr
			dec(1_800, 18), // minNetDebt
			dec(10_000_000_000, 18), // mintCap
			defaultFee // redemptionFeeFloor
		)
	}
}

module.exports = DeploymentHelper


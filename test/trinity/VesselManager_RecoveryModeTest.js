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

contract("VesselManager - in Recovery Mode", async accounts => {
	const _1_Ether = web3.utils.toWei("1", "ether")
	const _2_Ether = web3.utils.toWei("2", "ether")
	const _3_Ether = web3.utils.toWei("3", "ether")
	const _3pt5_Ether = web3.utils.toWei("3.5", "ether")
	const _6_Ether = web3.utils.toWei("6", "ether")
	const _10_Ether = web3.utils.toWei("10", "ether")
	const _20_Ether = web3.utils.toWei("20", "ether")
	const _21_Ether = web3.utils.toWei("21", "ether")
	const _22_Ether = web3.utils.toWei("22", "ether")
	const _24_Ether = web3.utils.toWei("24", "ether")
	const _25_Ether = web3.utils.toWei("25", "ether")
	const _30_Ether = web3.utils.toWei("30", "ether")

	const ZERO_ADDRESS = th.ZERO_ADDRESS
	const [
		owner,
		alice,
		bob,
		carol,
		dennis,
		erin,
		freddy,
		greta,
		harry,
		whale,
		defaulter_1,
		defaulter_2,
		defaulter_3,
		defaulter_4,
		A,
		B,
		C,
		D,
		E,
		F,
		G,
		H,
		I,
		treasury,
	] = accounts

	let REDEMPTION_SOFTENING_PARAM

	const openVessel = async params => th.openVessel(contracts.core, params)
	const calcSoftnedAmount = (collAmount, price) =>
		collAmount.mul(mv._1e18BN).mul(REDEMPTION_SOFTENING_PARAM).div(toBN(10000)).div(price)

	async function getDepositorGain(depositor, validCollaterals, asset) {
		const depositorGains = await stabilityPool.getDepositorGains(depositor, validCollaterals)

		const index = depositorGains[0].findIndex(collateral => collateral.toLowerCase() === asset.toLowerCase())
		return depositorGains[1][index]
	}

	before(async () => {
		await deploy(treasury, accounts.slice(0, 40))
		await setBalance(shortTimelock.address, 1e18)
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

	it("checkRecoveryMode(): Returns true if TCR falls below CCR", async () => {
		// --- SETUP ---
		//  Alice and Bob withdraw such that the TCR is ~150%
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

		const TCR_Asset = (await th.getTCR(contracts.core, erc20.address)).toString()
		assert.equal(TCR_Asset, dec(15, 17))

		assert.isFalse(await th.checkRecoveryMode(contracts.core, erc20.address))

		// --- TEST ---

		// price drops to 1ETH:150, reducing TCR below 150%. setPrice() calls checkTCRAndSetRecoveryMode() internally.
		await priceFeed.setPrice(erc20.address, dec(15, 17))

		// const price = await priceFeed.getPrice(erc20.address)
		// await vesselManager.checkTCRAndSetRecoveryMode(price)

		assert.isTrue(await th.checkRecoveryMode(contracts.core, erc20.address))
	})

	it("checkRecoveryMode(): Returns true if TCR stays less than CCR", async () => {
		// --- SETUP ---
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

		const TCR_Asset = (await th.getTCR(contracts.core, erc20.address)).toString()
		assert.equal(TCR_Asset, "1500000000000000000")

		// --- TEST ---

		// price drops to 1ETH:150, reducing TCR below 150%
		await priceFeed.setPrice(erc20.address, "150000000000000000000")

		assert.isTrue(await th.checkRecoveryMode(contracts.core, erc20.address))

		await borrowerOperations.addColl(erc20.address, 1, alice, alice, { from: alice })

		assert.isTrue(await th.checkRecoveryMode(contracts.core, erc20.address))
	})

	it("checkRecoveryMode(): returns false if TCR stays above CCR", async () => {
		// --- SETUP ---
		await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(450, 16)),
			extraParams: { from: alice },
		})
		await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(150, 16)),
			extraParams: { from: bob },
		})

		// --- TEST ---
		assert.isFalse(await th.checkRecoveryMode(contracts.core, erc20.address))

		await borrowerOperations.withdrawColl(erc20.address, _1_Ether, alice, alice, {
			from: alice,
		})

		assert.isFalse(await th.checkRecoveryMode(contracts.core, erc20.address))
	})

	it("checkRecoveryMode(): returns false if TCR rises above CCR", async () => {
		// --- SETUP ---
		const { collateral: A_coll_Asset } = await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(150, 16)),
			extraParams: { from: alice },
		})
		await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(150, 16)),
			extraParams: { from: bob },
		})

		const TCR_Asset = (await th.getTCR(contracts.core, erc20.address)).toString()
		assert.equal(TCR_Asset, "1500000000000000000")

		// --- TEST ---
		// price drops to 1ETH:150, reducing TCR below 150%
		await priceFeed.setPrice(erc20.address, "150000000000000000000")

		assert.isTrue(await th.checkRecoveryMode(contracts.core, erc20.address))

		await borrowerOperations.addColl(erc20.address, A_coll_Asset, alice, alice, {
			from: alice,
		})

		assert.isFalse(await th.checkRecoveryMode(contracts.core, erc20.address))
	})
})

contract("Reset chain state", async accounts => {})


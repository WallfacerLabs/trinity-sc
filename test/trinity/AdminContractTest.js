const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const th = testHelpers.TestHelper
const { dec, toBN, assertRevert, ZERO_ADDRESS } = th

var contracts
var snapshotId
var initialSnapshotId

const openVessel = async params => th.openVessel(contracts.core, params)
const deploy = async (treasury, distributor, mintingAccounts) => {
	contracts = await deploymentHelper.deployTestContracts(treasury, distributor, mintingAccounts)

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

contract("AdminContract", async accounts => {
	const [owner, user, A, C, B, treasury, distributor] = accounts

	let BORROWING_FEE
	let CCR
	let MCR
	let MIN_NET_DEBT
	let MINT_CAP
	let REDEMPTION_FEE_FLOOR

	const MCR_SAFETY_MAX = toBN(dec(10, 18))
	const MCR_SAFETY_MIN = toBN((1.01e18).toString())

	const CCR_SAFETY_MAX = toBN(dec(10, 18))
	const CCR_SAFETY_MIN = toBN(dec(0, 18))

	const BORROWING_FEE_SAFETY_MAX = toBN((0.1e18).toString()) // 10%
	const BORROWING_FEE_SAFETY_MIN = toBN(0)

	const MIN_NET_DEBT_SAFETY_MAX = toBN(dec(2_000, 18))
	const MIN_NET_DEBT_SAFETY_MIN = toBN(0)

	const REDEMPTION_FEE_FLOOR_SAFETY_MAX = toBN((0.1e18).toString()) // 10%
	const REDEMPTION_FEE_FLOOR_SAFETY_MIN = toBN('0') // 0%

	before(async () => {
		await deploy(treasury, distributor, accounts.slice(0, 5))

		BORROWING_FEE = await adminContract.BORROWING_FEE_DEFAULT()
		CCR = await adminContract.CCR_DEFAULT()
		MCR = await adminContract.MCR_DEFAULT()
		MIN_NET_DEBT = await adminContract.MIN_NET_DEBT_DEFAULT()
		MINT_CAP = await adminContract.MINT_CAP_DEFAULT()
		REDEMPTION_FEE_FLOOR = await adminContract.REDEMPTION_FEE_FLOOR_DEFAULT()

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

	it("Formula Checks: Call every function with default value, Should match default values", async () => {
		await adminContract.setBorrowingFee(ZERO_ADDRESS, (0.005e18).toString())
		await adminContract.setCCR(ZERO_ADDRESS, "0")
		await adminContract.setMCR(ZERO_ADDRESS, "1100000000000000000")
		await adminContract.setMinNetDebt(ZERO_ADDRESS, dec(2_000, 18))
		await adminContract.setMintCap(ZERO_ADDRESS, dec(1_000_000, 18))
		await adminContract.setRedemptionFeeFloor(ZERO_ADDRESS, '0')

		assert.equal((await adminContract.getBorrowingFee(ZERO_ADDRESS)).toString(), BORROWING_FEE)
		assert.equal((await adminContract.getCcr(ZERO_ADDRESS)).toString(), CCR)
		assert.equal((await adminContract.getMcr(ZERO_ADDRESS)).toString(), MCR)
		assert.equal((await adminContract.getMinNetDebt(ZERO_ADDRESS)).toString(), MIN_NET_DEBT)
		assert.equal((await adminContract.getMintCap(ZERO_ADDRESS)).toString(), MINT_CAP)
		assert.equal((await adminContract.getRedemptionFeeFloor(ZERO_ADDRESS)).toString(), REDEMPTION_FEE_FLOOR)
	})

	it("Try to edit Parameters as User, Revert Transactions", async () => {
		await assertRevert(
			adminContract.setCollateralParameters(
				ZERO_ADDRESS,
				BORROWING_FEE,
				CCR,
				MCR,
				MIN_NET_DEBT,
				MINT_CAP,
				REDEMPTION_FEE_FLOOR,
				{ from: user }
			)
		)
		await assertRevert(adminContract.setMCR(ZERO_ADDRESS, MCR, { from: user }))
		await assertRevert(adminContract.setCCR(ZERO_ADDRESS, CCR, { from: user }))
		await assertRevert(adminContract.setMinNetDebt(ZERO_ADDRESS, MIN_NET_DEBT, { from: user }))
		await assertRevert(adminContract.setBorrowingFee(ZERO_ADDRESS, BORROWING_FEE, { from: user }))
		await assertRevert(adminContract.setRedemptionFeeFloor(ZERO_ADDRESS, REDEMPTION_FEE_FLOOR, { from: user }))
	})

	it("setMCR: Owner change parameter - Failing SafeCheck", async () => {
		await assertRevert(adminContract.setMCR(ZERO_ADDRESS, MCR_SAFETY_MIN.sub(toBN(1))))
		await assertRevert(adminContract.setMCR(ZERO_ADDRESS, MCR_SAFETY_MAX.add(toBN(1))))
	})

	it("setMCR: Owner change parameter - Valid SafeCheck", async () => {
		await adminContract.setMCR(ZERO_ADDRESS, MCR_SAFETY_MIN)
		assert.equal(MCR_SAFETY_MIN.toString(), await adminContract.getMcr(ZERO_ADDRESS))

		await adminContract.setMCR(ZERO_ADDRESS, MCR_SAFETY_MAX)
		assert.equal(MCR_SAFETY_MAX.toString(), await adminContract.getMcr(ZERO_ADDRESS))
	})

	it("setCCR: Owner change parameter - Failing SafeCheck", async () => {
		await assertRevert(adminContract.setCCR(ZERO_ADDRESS, CCR_SAFETY_MAX.add(toBN(1))))
	})

	it("setCCR: Owner change parameter - Valid SafeCheck", async () => {
		await adminContract.setCCR(ZERO_ADDRESS, CCR_SAFETY_MIN)
		assert.equal(CCR_SAFETY_MIN.toString(), await adminContract.getCcr(ZERO_ADDRESS))

		await adminContract.setCCR(ZERO_ADDRESS, CCR_SAFETY_MAX)
		assert.equal(CCR_SAFETY_MAX.toString(), await adminContract.getCcr(ZERO_ADDRESS))
	})

	it("setMinNetDebt: Owner change parameter - Failing SafeCheck", async () => {
		await assertRevert(adminContract.setMinNetDebt(ZERO_ADDRESS, MIN_NET_DEBT_SAFETY_MAX.add(toBN(1))))
	})

	it("setMinNetDebt: Owner change parameter - Valid SafeCheck", async () => {
		await adminContract.setMinNetDebt(ZERO_ADDRESS, MIN_NET_DEBT_SAFETY_MIN)
		assert.equal(MIN_NET_DEBT_SAFETY_MIN.toString(), await adminContract.getMinNetDebt(ZERO_ADDRESS))

		await adminContract.setMinNetDebt(ZERO_ADDRESS, MIN_NET_DEBT_SAFETY_MAX)
		assert.equal(MIN_NET_DEBT_SAFETY_MAX.toString(), await adminContract.getMinNetDebt(ZERO_ADDRESS))
	})

	it("setBorrowingFee: Owner change parameter - Failing SafeCheck", async () => {
		await assertRevert(adminContract.setBorrowingFee(ZERO_ADDRESS, BORROWING_FEE_SAFETY_MAX.add(toBN(1))))
	})

	it("setBorrowingFeeFloor: Owner change parameter - Valid SafeCheck", async () => {
		await adminContract.setBorrowingFee(ZERO_ADDRESS, BORROWING_FEE_SAFETY_MIN)
		assert.equal(BORROWING_FEE_SAFETY_MIN.toString(), await adminContract.getBorrowingFee(ZERO_ADDRESS))

		await adminContract.setBorrowingFee(ZERO_ADDRESS, BORROWING_FEE_SAFETY_MAX)
		assert.equal(BORROWING_FEE_SAFETY_MAX.toString(), await adminContract.getBorrowingFee(ZERO_ADDRESS))
	})

	it("setRedemptionFeeFloor: Owner change parameter - Failing SafeCheck", async () => {
		await assertRevert(adminContract.setRedemptionFeeFloor(ZERO_ADDRESS, REDEMPTION_FEE_FLOOR_SAFETY_MAX.add(toBN(1))))
	})

	it("setRedemptionFeeFloor: Owner change parameter - Valid SafeCheck", async () => {
		await adminContract.setRedemptionFeeFloor(ZERO_ADDRESS, REDEMPTION_FEE_FLOOR_SAFETY_MIN)
		assert.equal(REDEMPTION_FEE_FLOOR_SAFETY_MIN.toString(), await adminContract.getRedemptionFeeFloor(ZERO_ADDRESS))

		await adminContract.setRedemptionFeeFloor(ZERO_ADDRESS, REDEMPTION_FEE_FLOOR_SAFETY_MAX)
		assert.equal(REDEMPTION_FEE_FLOOR_SAFETY_MAX.toString(), await adminContract.getRedemptionFeeFloor(ZERO_ADDRESS))
	})

	it("setCollateralParameters: Owner change parameter - Failing SafeCheck", async () => {
		await assertRevert(
			adminContract.setCollateralParameters(
				ZERO_ADDRESS,
				BORROWING_FEE_SAFETY_MAX.add(toBN(1)),
				CCR,
				MCR,
				MIN_NET_DEBT,
				MINT_CAP,
				REDEMPTION_FEE_FLOOR
			)
		)
		await assertRevert(
			adminContract.setCollateralParameters(
				ZERO_ADDRESS,
				BORROWING_FEE,
				CCR_SAFETY_MAX.add(toBN(1)),
				MCR,
				MIN_NET_DEBT,
				MINT_CAP,
				REDEMPTION_FEE_FLOOR
			)
		)
		await assertRevert(
			adminContract.setCollateralParameters(
				ZERO_ADDRESS,
				BORROWING_FEE,
				CCR,
				MCR_SAFETY_MAX.add(toBN(1)),
				MIN_NET_DEBT,
				MINT_CAP,
				REDEMPTION_FEE_FLOOR
			)
		)
		await assertRevert(
			adminContract.setCollateralParameters(
				ZERO_ADDRESS,
				BORROWING_FEE,
				CCR,
				MCR,
				MIN_NET_DEBT_SAFETY_MAX.add(toBN(1)),
				MINT_CAP,
				REDEMPTION_FEE_FLOOR
			)
		)
		await assertRevert(
			adminContract.setCollateralParameters(
				ZERO_ADDRESS,
				BORROWING_FEE,
				CCR,
				MCR,
				MIN_NET_DEBT,
				MINT_CAP,
				REDEMPTION_FEE_FLOOR_SAFETY_MAX.add(toBN(1))
			)
		)
	})

	it("openVessel(): Borrowing at zero base rate charges minimum fee with different borrowingFeeFloor", async () => {
		await adminContract.setBorrowingFee(erc20.address, BORROWING_FEE_SAFETY_MAX)

		assert.equal(BORROWING_FEE_SAFETY_MAX.toString(), await adminContract.getBorrowingFee(erc20.address))

		await openVessel({
			asset: erc20.address,
			extraTRIAmount: toBN(dec(5000, 18)),
			ICR: toBN(dec(2, 18)),
			extraParams: { from: A },
		})
		await openVessel({
			asset: erc20.address,
			extraTRIAmount: toBN(dec(5000, 18)),
			ICR: toBN(dec(2, 18)),
			extraParams: { from: B },
		})

		const USDVRequest = toBN(dec(10000, 18))
		const txC_Asset = await borrowerOperations.openVessel(
			erc20.address,
			dec(100, "ether"),
			USDVRequest,
			ZERO_ADDRESS,
			ZERO_ADDRESS,
			{ from: C }
		)
		const _USDVFee_Asset = toBN(th.getEventArgByName(txC_Asset, "BorrowingFeePaid", "_feeAmount"))

		const expectedFee_Asset = (await adminContract.getBorrowingFee(erc20.address))
			.mul(toBN(USDVRequest))
			.div(toBN(dec(1, 18)))
		assert.isTrue(_USDVFee_Asset.eq(expectedFee_Asset))
	})

	it('setAddressCollateralWhitelisted: Owner change parameter - Valid Owner', async () => {
		await adminContract.setAddressCollateralWhitelisted(erc20.address, ZERO_ADDRESS, true)
		assert.isTrue(await adminContract.getIsAddressCollateralWhitelisted(erc20.address, ZERO_ADDRESS))
		await adminContract.setAddressCollateralWhitelisted(erc20.address, ZERO_ADDRESS, false)
		assert.isFalse(await adminContract.getIsAddressCollateralWhitelisted(erc20.address, ZERO_ADDRESS))
	})

	it('setAddressCollateralWhitelisted: Owner change parameter - Invalid Owner', async () => {
		await assertRevert(adminContract.setAddressCollateralWhitelisted(erc20.address, ZERO_ADDRESS, true, {from: user}))
		await assertRevert(adminContract.setAddressCollateralWhitelisted(erc20.address, ZERO_ADDRESS, false, {from: user}))
	})

	it('setLiquidatorWhitelisted: Owner change parameter - Valid Owner', async () => {
		await adminContract.setLiquidatorWhitelisted(ZERO_ADDRESS, true)
		assert.isTrue(await adminContract.getIsLiquidatorWhitelisted(ZERO_ADDRESS))
		await adminContract.setLiquidatorWhitelisted(ZERO_ADDRESS, false)
		assert.isFalse(await adminContract.getIsLiquidatorWhitelisted(ZERO_ADDRESS))
	})

	it('setLiquidatorWhitelisted: Owner change parameter - Invalid Owner', async () => {
		await assertRevert(adminContract.setLiquidatorWhitelisted(ZERO_ADDRESS, true, {from: user}))
		await assertRevert(adminContract.setLiquidatorWhitelisted(ZERO_ADDRESS, false, {from: user}))
	})

	it('setRedemptionBaseFeeEnabled: Owner change parameter - Valid Owner', async () => {
		await adminContract.setRedemptionBaseFeeEnabled(ZERO_ADDRESS, true)
		assert.isTrue(await adminContract.getRedemptionBaseFeeEnabled(ZERO_ADDRESS))
		await adminContract.setRedemptionBaseFeeEnabled(ZERO_ADDRESS, false)
		assert.isFalse(await adminContract.getRedemptionBaseFeeEnabled(ZERO_ADDRESS))
	})

	it('setRedemptionBaseFeeEnabled: Owner change parameter - Invalid Owner', async () => {
		await assertRevert(adminContract.setRedemptionBaseFeeEnabled(ZERO_ADDRESS, true, {from: user}))
		await assertRevert(adminContract.setRedemptionBaseFeeEnabled(ZERO_ADDRESS, false, {from: user}))
	})
})

contract("Reset chain state", async accounts => {})

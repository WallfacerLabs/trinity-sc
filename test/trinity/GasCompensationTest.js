const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const th = testHelpers.TestHelper
const { dec, toBN } = th
const mv = testHelpers.MoneyValues

var contracts
var snapshotId
var initialSnapshotId
var validCollateral

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

	validCollateral = await adminContract.getValidCollateral()
}

contract("Gas compensation tests", async accounts => {
	const [liquidator, alice, bob, carol, dennis, erin, flyn, harriet, whale, treasury, distributor] = accounts

	const logICRs = ICRList => {
		for (let i = 0; i < ICRList.length; i++) {
			console.log(`account: ${i + 1} ICR: ${ICRList[i].toString()}`)
		}
	}

	before(async () => {
		await deploy(treasury, distributor, accounts.slice(0, 25))
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

	// --- Test ICRs with virtual debt ---
	it("getCurrentICR(): Incorporates virtual debt, and returns the correct ICR for new vessels", async () => {
		const price = await priceFeed.getPrice(erc20.address)
		await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(200, 18)),
			extraParams: { from: whale },
		})

		// A opens with 1 ETH, 110 TRI
		await openVessel({
			asset: erc20.address,
			ICR: toBN("1818181818181818181"),
			extraParams: { from: alice },
		})
		const alice_ICRERC20 = (await vesselManager.getCurrentICR(erc20.address, alice, price)).toString()
		// Expect aliceICR = (1 * 200) / (110) = 181.81%
		assert.isAtMost(th.getDifference(alice_ICRERC20, "1818181818181818181"), 1000)

		// B opens with 0.5 ETH, 50 TRI
		await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(2, 18)),
			extraParams: { from: bob },
		})
		const bob_ICRERC20 = (await vesselManager.getCurrentICR(erc20.address, bob, price)).toString()
		// Expect Bob's ICR = (0.5 * 200) / 50 = 200%
		assert.isAtMost(th.getDifference(bob_ICRERC20, dec(2, 18)), 1000)

		// F opens with 1 ETH, 100 TRI

		await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(2, 18)),
			extraTRIAmount: dec(100, 18),
			extraParams: { from: flyn },
		})
		const flyn_ICRERC20 = (await vesselManager.getCurrentICR(erc20.address, flyn, price)).toString()
		// Expect Flyn's ICR = (1 * 200) / 100 = 200%
		assert.isAtMost(th.getDifference(flyn_ICRERC20, dec(2, 18)), 1000)

		// C opens with 2.5 ETH, 160 TRI
		await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(3125, 15)),
			extraParams: { from: carol },
		})
		const carol_ICRERC20 = (await vesselManager.getCurrentICR(erc20.address, carol, price)).toString()
		// Expect Carol's ICR = (2.5 * 200) / (160) = 312.50%
		assert.isAtMost(th.getDifference(carol_ICRERC20, "3125000000000000000"), 1000)

		// D opens with 1 ETH, 0 TRI
		await openVessel({
			asset: erc20.address,
			ICR: toBN(dec(4, 18)),
			extraParams: { from: dennis },
		})
		const dennis_ICRERC20 = (await vesselManager.getCurrentICR(erc20.address, dennis, price)).toString()
		// Expect Dennis's ICR = (1 * 200) / (50) = 400.00%
		assert.isAtMost(th.getDifference(dennis_ICRERC20, dec(4, 18)), 1000)

		// E opens with 4405.45 ETH, 32598.35 TRI
		await openVessel({
			asset: erc20.address,
			ICR: toBN("27028668628933700000"),
			extraParams: { from: erin },
		})
		const erin_ICRERC20 = (await vesselManager.getCurrentICR(erc20.address, erin, price)).toString()
		// Expect Erin's ICR = (4405.45 * 200) / (32598.35) = 2702.87%
		assert.isAtMost(th.getDifference(erin_ICRERC20, "27028668628933700000"), 100000)

		// H opens with 1 ETH, 180 TRI
		await openVessel({
			asset: erc20.address,
			ICR: toBN("1111111111111111111"),
			extraParams: { from: harriet },
		})
		const harriet_ICRERC20 = (await vesselManager.getCurrentICR(erc20.address, harriet, price)).toString()
		// Expect Harriet's ICR = (1 * 200) / (180) = 111.11%
		assert.isAtMost(th.getDifference(harriet_ICRERC20, "1111111111111111111"), 1000)
	})


	// --- Vessel ordering by ICR tests ---

	it("Vessel ordering: same collateral, decreasing debt. Price successively increases. Vessels should maintain ordering by ICR", async () => {
		const _10_accounts = accounts.slice(1, 11)

		let debt = 50
		// create 10 vessels, constant coll, descending debt 100 to 90 TRI
		for (const account of _10_accounts) {
			const debtString = debt.toString().concat("000000000000000000")

			await openVessel({
				asset: erc20.address,
				assetSent: dec(30, "ether"),
				extraTRIAmount: debtString,
				extraParams: { from: account },
			})

			debt -= 1
		}

		// Vary price 200-210
		let price = 200
		while (price < 210) {
			const priceString = price.toString().concat("000000000000000000")
			await priceFeed.setPrice(erc20.address, priceString)

			const ICRListERC20 = []

			for (account of _10_accounts) {
				const collERC20 = (await vesselManager.Vessels(account, erc20.address))[th.VESSEL_COLL_INDEX]

				const ICRERC20 = await vesselManager.getCurrentICR(erc20.address, account, price)
				ICRListERC20.push(ICRERC20)

				// Check vessel ordering by ICR is maintained

				if (ICRListERC20.length > 1) {
					const prevICRERC20 = ICRListERC20[ICRListERC20.length - 2]

					try {
						assert.isTrue(ICRERC20.gte(prevICRERC20))
					} catch (error) {
						console.log(`ETH price at which vessel ordering breaks: ${price}`)
						// logICRs(ICRListERC20)
					}
				}

				price += 1
			}
		}
	})

	it("Vessel ordering: increasing collateral, constant debt. Price successively increases. Vessels should maintain ordering by ICR", async () => {
		const _20_accounts = accounts.slice(1, 21)

		let coll = 50
		// create 20 vessels, increasing collateral, constant debt = 100TRI
		for (const account of _20_accounts) {
			const collString = coll.toString().concat("000000000000000000")

			await openVessel({
				asset: erc20.address,
				assetSent: collString,
				extraTRIAmount: dec(100, 18),
				extraParams: { from: account },
			})

			coll += 5
		}

		// Vary price
		let price = 1
		while (price < 300) {
			const priceString = price.toString().concat("000000000000000000")
			await priceFeed.setPrice(erc20.address, priceString)

			const ICRListERC20 = []

			for (account of _20_accounts) {
				const ICRERC20 = await vesselManager.getCurrentICR(erc20.address, account, price)
				ICRListERC20.push(ICRERC20)

				// Check vessel ordering by ICR is maintained
				if (ICRListERC20.lengthERC20 > 1) {
					const prevICRERC20 = ICRListERC20[ICRListERC20.length - 2]

					try {
						assert.isTrue(ICRERC20.gte(prevICRERC20))
					} catch (error) {
						console.log(`ETH price at which vessel ordering breaks: ${price}`)
						// logICRs(ICRListERC20)
					}
				}

				price += 10
			}
		}
	})

	it("Vessel ordering: Constant raw collateral ratio (excluding virtual debt). Price successively increases. Vessels should maintain ordering by ICR", async () => {
		let collVals = [1, 5, 10, 25, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000].map(
			v => v * 20
		)
		const accountsList = accounts.slice(1, collVals.length + 1)

		let accountIdx = 0
		for (const coll of collVals) {
			const account = accountsList[accountIdx]
			const collString = coll.toString().concat("000000000000000000")

			await openVessel({
				asset: erc20.address,
				assetSent: collString,
				extraTRIAmount: dec(100, 18),
				extraParams: { from: account },
			})

			accountIdx += 1
		}

		// Vary price
		let price = 1
		while (price < 300) {
			const priceString = price.toString().concat("000000000000000000")
			await priceFeed.setPrice(erc20.address, priceString)

			const ICRListERC20 = []

			for (account of accountsList) {
				const ICRERC20 = await vesselManager.getCurrentICR(erc20.address, account, price)
				ICRListERC20.push(ICRERC20)

				// Check vessel ordering by ICR is maintained

				if (ICRListERC20.length > 1) {
					const prevICRERC20 = ICRListERC20[ICRListERC20.length - 2]

					try {
						assert.isTrue(ICRERC20.gte(prevICRERC20))
					} catch (error) {
						console.log(error)
						console.log(`ETH price at which vessel ordering breaks: ${price}`)
						// logICRs(ICRListERC20)
					}
				}

				price += 10
			}
		}
	})
})

contract("Reset chain state", async accounts => {})


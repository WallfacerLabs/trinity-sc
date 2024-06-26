const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const {constants} = require('ethers')

const th = testHelpers.TestHelper
const {dec, toBN} = th

const {SECONDS_IN_ONE_WEEK} = testHelpers.TimeValues
const {_1e18BN} = testHelpers.MoneyValues


contract("BorrowerOperations_Fees", async accounts => {
    const [_, alice, bob, treasury, distributor] = accounts

    let contracts
    let snapshotId
    let initialSnapshotId

    const vesselColl = toBN(dec(1000, 18))
    const vesselTotalDebt = toBN(dec(100000, 18))
    const borrowingFee = toBN(dec(5, 15))


    async function openVessel(account) {
        const {borrowerOperations, erc20} = contracts.core
        const vesselTRIAmount_Asset = await th.getOpenVesselTRIAmount(contracts.core, vesselTotalDebt, erc20.address)
        return borrowerOperations.openVessel(erc20.address, vesselColl, vesselTRIAmount_Asset, constants.AddressZero, constants.AddressZero, {
            from: account,
        })
    }

    async function closeVessel(account) {
        const {borrowerOperations, erc20} = contracts.core
        return borrowerOperations.closeVessel(erc20.address, {
            from: account,
        })
    }

    async function mintDebtTokens(account, amount) {
        return contracts.core.debtToken.unprotectedMint(account, amount)
    }

    async function skipToNextEpoch() {
        await th.fastForwardTime(SECONDS_IN_ONE_WEEK, web3.currentProvider)
    }

    function getDebtWithFee(debt) {
        return debt.add(debt.mul(borrowingFee).div(_1e18BN))
    }

    function getFee(debt) {
        return debt.mul(borrowingFee).div(_1e18BN)
    }

    function getEpochUpdatedEvent(tx) {
        for (let i = 0; i < tx.logs.length; i++) {
            if (tx.logs[i].event === "VesselEpochUpdated") {
                const asset = tx.logs[i].args[0]
                const borrower = tx.logs[i].args[1]
                const epoch = tx.logs[i].args[2]

                return {asset, borrower, epoch}
            }
        }
        throw "The transaction logs do not contain an epoch updated event"
    }

    before(async () => {
        contracts = await deploymentHelper.deployTestContracts(treasury, distributor, [])

        for (const acc of accounts.slice(0, 20)) {
            await contracts.core.erc20.mint(acc, await web3.eth.getBalance(acc))
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

    describe('openVessel', () => {
        it('pays initial fee', async () => {
            const {debtToken, erc20} = contracts.core

            const initialDistributorBalance = await debtToken.balanceOf(distributor)
            assert.isTrue(initialDistributorBalance.eq(toBN(0)))

            await openVessel(alice)

            const vesselTRIAmount_Asset = await th.getOpenVesselTRIAmount(contracts.core, vesselTotalDebt, erc20.address)
            const expectedFeeAmount = vesselTRIAmount_Asset.mul(borrowingFee).div(_1e18BN).toString()
            const distributorBalance = await debtToken.balanceOf(distributor)

            assert.equal(distributorBalance, expectedFeeAmount)
        })

        it('updates epoch', async () => {
            const {erc20, borrowerOperations} = contracts.core

            const epochBefore = await borrowerOperations.lastFeeCollectionEpoch(erc20.address, alice)
            assert.isTrue(epochBefore.eq(toBN(0)))

            await openVessel(alice)

            const epochAfter = await borrowerOperations.lastFeeCollectionEpoch(erc20.address, alice)
            const currentTimestamp = th.toBN(await th.getLatestBlockTimestamp(web3))
            const expectedTimestamp = currentTimestamp.sub(currentTimestamp.mod(toBN(SECONDS_IN_ONE_WEEK)))

            assert.isTrue(epochAfter.eq(expectedTimestamp))
        })

        it('emits event on updated epoch', async () => {
            const tx = await openVessel(alice)

            const {asset, borrower, epoch} = getEpochUpdatedEvent(tx)
            assert.equal(asset, contracts.core.erc20.address)
            assert.equal(borrower, alice)

            const currentTimestamp = th.toBN(await th.getLatestBlockTimestamp(web3))
            const expectedTimestamp = currentTimestamp.sub(currentTimestamp.mod(toBN(SECONDS_IN_ONE_WEEK)))
            assert.isTrue(epoch.eq(expectedTimestamp))
        })
    })

    describe('adjustVessel', () => {
        it('updates epoch', async () => {
            const {erc20, borrowerOperations} = contracts.core

            await openVessel(alice)
            const epochBefore = await borrowerOperations.lastFeeCollectionEpoch(erc20.address, alice)

            await skipToNextEpoch()
            await borrowerOperations.adjustVessel(erc20.address,
                dec(100, "ether"),
                0,
                dec(50, 18),
                true,
                alice,
                alice,
                { from: alice }
            )

            const epochAfter = await borrowerOperations.lastFeeCollectionEpoch(erc20.address, alice)
            const currentTimestamp = th.toBN(await th.getLatestBlockTimestamp(web3))
            const expectedTimestamp = currentTimestamp.sub(currentTimestamp.mod(toBN(SECONDS_IN_ONE_WEEK)))

            assert.isTrue(epochAfter.eq(expectedTimestamp))
            assert.isFalse(epochAfter.eq(epochBefore))
        })

        it('pays only partialFee if already paid in same epoch', async () => {
            const {erc20, borrowerOperations, vesselManager} = contracts.core
            await openVessel(alice)

            const debtBefore = await vesselManager.getVesselDebt(erc20.address, alice)

            const withdrawAmount = toBN(dec(100, 18))

            await borrowerOperations.withdrawDebtTokens(erc20.address, withdrawAmount, alice, alice, {from: alice})

            const debtAfter = await vesselManager.getVesselDebt(erc20.address, alice)

            const expectedDebtAfter = debtBefore.add(getDebtWithFee(withdrawAmount))

            assert.isTrue(debtAfter.eq(expectedDebtAfter))
        })

        it('pays full fee if not paid in same epoch', async () => {
            const {erc20, borrowerOperations, vesselManager} = contracts.core
            await openVessel(alice)
            await skipToNextEpoch()

            const debtBefore = await vesselManager.getVesselDebt(erc20.address, alice)

            const withdrawAmount = toBN(dec(100, 18))

            await borrowerOperations.withdrawDebtTokens(erc20.address, withdrawAmount, alice, alice, {from: alice})

            const debtAfter = await vesselManager.getVesselDebt(erc20.address, alice)

            const expectedDebtAfter = getDebtWithFee(debtBefore).add(getDebtWithFee(withdrawAmount))

            assert.isTrue(debtAfter.eq(expectedDebtAfter))
        })

        it('emits event on updated epoch', async () => {
            const {borrowerOperations, erc20} = contracts.core
            await openVessel(alice)
            await skipToNextEpoch()

            const withdrawAmount = toBN(dec(100, 18))

            const tx = await borrowerOperations.withdrawDebtTokens(erc20.address, withdrawAmount, alice, alice, {from: alice})

            const {asset, borrower, epoch} = getEpochUpdatedEvent(tx)
            assert.equal(asset, contracts.core.erc20.address)
            assert.equal(borrower, alice)

            const currentTimestamp = th.toBN(await th.getLatestBlockTimestamp(web3))
            const expectedTimestamp = currentTimestamp.sub(currentTimestamp.mod(toBN(SECONDS_IN_ONE_WEEK)))
            assert.isTrue(epoch.eq(expectedTimestamp))
        })
    })

    describe('closeVessel', () => {
        it('does not add fees mid epoch', async () => {
            const {erc20, debtToken, borrowerOperations} = contracts.core
            await openVessel(alice)
            await skipToNextEpoch()
            
            const debtBeforeFeeCollection = await contracts.core.vesselManager.getVesselDebt(erc20.address, alice)
            const distributorBalanceBeforeFeeCollection = await debtToken.balanceOf(distributor)
            await borrowerOperations.collectVesselFee(erc20.address, alice)
            
            const distributorBalancePostFeeCollection = await debtToken.balanceOf(distributor)
            const expectedFee = getFee(debtBeforeFeeCollection)
            assert.equal(distributorBalancePostFeeCollection.toString(), distributorBalanceBeforeFeeCollection.add(expectedFee).toString())
            
            // bob opens vessel so alice can close hers
            await openVessel(bob)

            const distributorBalanceBeforeClose = await debtToken.balanceOf(distributor)
            await th.fastForwardTime(SECONDS_IN_ONE_WEEK / 2, web3.currentProvider)
            await mintDebtTokens(alice, vesselTotalDebt)
            await closeVessel(alice)

            const distributorBalancePostClose = await debtToken.balanceOf(distributor)
            assert.equal(distributorBalancePostClose.toString(), distributorBalanceBeforeClose.toString())
        })

        it('skips due fee payment when called before collectVesselFee', async () => {
            const {erc20, debtToken, borrowerOperations} = contracts.core
            await openVessel(alice)
            await skipToNextEpoch()
            
            const debtBeforeFeeCollection = await contracts.core.vesselManager.getVesselDebt(erc20.address, alice)
            const distributorBalanceBeforeFeeCollection = await debtToken.balanceOf(distributor)
            await borrowerOperations.collectVesselFee(erc20.address, alice)
            
            const distributorBalancePostFeeCollection = await debtToken.balanceOf(distributor)
            const expectedFee = getFee(debtBeforeFeeCollection)
            assert.equal(distributorBalancePostFeeCollection.toString(), distributorBalanceBeforeFeeCollection.add(expectedFee).toString())
            
            // bob opens vessel so alice can close hers
            await openVessel(bob)

            const distributorBalanceBeforeClose = await debtToken.balanceOf(distributor)
            await skipToNextEpoch()
            await mintDebtTokens(alice, vesselTotalDebt)
            await closeVessel(alice)

            const distributorBalancePostClose = await debtToken.balanceOf(distributor)
            assert.equal(distributorBalancePostClose.toString(), distributorBalanceBeforeClose.toString())
        })
    })

    describe('collectVesselFee', () => {
        it('does nothing if called twice in single epoch', async () => {
            const {erc20, borrowerOperations, vesselManager} = contracts.core
            await openVessel(alice)

            await borrowerOperations.collectVesselFee(erc20.address, alice)

            const vesselDebtBefore = await vesselManager.getVesselDebt(erc20.address, alice)
            await borrowerOperations.collectVesselFee(erc20.address, alice)
            const vesselDebtAfter = await vesselManager.getVesselDebt(erc20.address, alice)

            assert.isTrue(vesselDebtAfter.eq(vesselDebtBefore))
        })

        it('adds fees to vessel debt', async () => {
            const {erc20, borrowerOperations, vesselManager} = contracts.core
            await openVessel(alice)
            await skipToNextEpoch()

            const vesselDebtBefore = await vesselManager.getVesselDebt(erc20.address, alice)

            await borrowerOperations.collectVesselFee(erc20.address, alice)

            const vesselDebtAfter = await vesselManager.getVesselDebt(erc20.address, alice)

            assert.isTrue(vesselDebtAfter.eq(getDebtWithFee(vesselDebtBefore)))
        })

        it('can be called twice in different epochs', async () => {
            const {erc20, borrowerOperations, vesselManager} = contracts.core
            await openVessel(alice)
            await skipToNextEpoch()

            const vesselDebtBefore = await vesselManager.getVesselDebt(erc20.address, alice)

            await borrowerOperations.collectVesselFee(erc20.address, alice)

            const vesselDebtAfter = await vesselManager.getVesselDebt(erc20.address, alice)

            assert.isTrue(vesselDebtAfter.eq(getDebtWithFee(vesselDebtBefore)))

            await skipToNextEpoch()

            await borrowerOperations.collectVesselFee(erc20.address, alice)

            const vesselDebtAfterSecondTimeTravel = await vesselManager.getVesselDebt(erc20.address, alice)

            assert.isTrue(vesselDebtAfterSecondTimeTravel.eq(getDebtWithFee(vesselDebtAfter)))
        })

        it('updates epoch of collected asset', async () => {
            const {erc20, borrowerOperations} = contracts.core

            await openVessel(alice)
            const epochBefore = await borrowerOperations.lastFeeCollectionEpoch(erc20.address, alice)

            await skipToNextEpoch()
            await borrowerOperations.collectVesselFee(erc20.address, alice)

            const epochAfter = await borrowerOperations.lastFeeCollectionEpoch(erc20.address, alice)
            const currentTimestamp = th.toBN(await th.getLatestBlockTimestamp(web3))
            const expectedTimestamp = currentTimestamp.sub(currentTimestamp.mod(toBN(SECONDS_IN_ONE_WEEK)))

            assert.isTrue(epochAfter.eq(expectedTimestamp))
            assert.isFalse(epochAfter.eq(epochBefore))
        })

        it('emits event on updated epoch', async () => {
            const {borrowerOperations, erc20} = contracts.core
            await openVessel(alice)
            await skipToNextEpoch()

            const withdrawAmount = toBN(dec(100, 18))

            const tx = await borrowerOperations.withdrawDebtTokens(erc20.address, withdrawAmount, alice, alice, {from: alice})

            const {asset, borrower, epoch} = getEpochUpdatedEvent(tx)
            assert.equal(asset, contracts.core.erc20.address)
            assert.equal(borrower, alice)

            const currentTimestamp = th.toBN(await th.getLatestBlockTimestamp(web3))
            const expectedTimestamp = currentTimestamp.sub(currentTimestamp.mod(toBN(SECONDS_IN_ONE_WEEK)))
            assert.isTrue(epoch.eq(expectedTimestamp))
        })

        it('adds to both vessel debt and global debt', async () => {
            const {activePool, borrowerOperations, vesselManager, erc20} = contracts.core
            await openVessel(alice)
    
            const initialAliceDebt = await vesselManager.getVesselDebt(erc20.address, alice)
            const initialTotalDebt = await activePool.getDebtTokenBalance(erc20.address)
    
            await skipToNextEpoch()
            await borrowerOperations.collectVesselFee(erc20.address, alice)
    
            const newAliceDebt = await vesselManager.getVesselDebt(erc20.address, alice)
            const newGlobalDebt = await activePool.getDebtTokenBalance(erc20.address)
    
            assert.equal(newAliceDebt.toString(), getDebtWithFee(initialAliceDebt).toString())
            assert.equal(newGlobalDebt.toString(), getDebtWithFee(initialTotalDebt).toString())
        })

        it("adjust vessel adds to both vessel debt and global debt", async () => {
            const { activePool, borrowerOperations, vesselManager, erc20 } = contracts.core
            await openVessel(alice)

            const initialAliceDebt = await vesselManager.getVesselDebt(erc20.address, alice)
            const initialTotalDebt = await activePool.getDebtTokenBalance(erc20.address)

            await skipToNextEpoch()
            await borrowerOperations.adjustVessel(erc20.address, 0, 1, 0, false, alice, alice, { from: alice })

            const newAliceDebt = await vesselManager.getVesselDebt(erc20.address, alice)
            const newGlobalDebt = await activePool.getDebtTokenBalance(erc20.address)

            assert.equal(newAliceDebt.toString(), getDebtWithFee(initialAliceDebt).toString())
            assert.equal(newGlobalDebt.toString(), getDebtWithFee(initialTotalDebt).toString())
		})

        it('can close vessel if vesselDebt > activePoolDebt', async () => {
            const {activePool, borrowerOperations, vesselManager, debtToken, erc20} = contracts.core
            await openVessel(alice)
            await debtToken.unprotectedMint(alice, vesselTotalDebt)

            const activePoolInitialDebt = await activePool.getDebtTokenBalance(erc20.address)
    
            await skipToNextEpoch()
    
            await borrowerOperations.collectVesselFee(erc20.address, alice)

            const vesselDebt = await vesselManager.getVesselDebt(erc20.address, alice)
            const activePoolDebt = await activePool.getDebtTokenBalance(erc20.address)

            assert.isTrue(vesselDebt.gt(activePoolInitialDebt))
            assert.equal(vesselDebt.toString(), activePoolDebt.toString())
            assert.isTrue(await vesselManager.isVesselActive(erc20.address, alice))
    
            await openVessel(bob)
            await closeVessel(alice)

            assert.isFalse(await vesselManager.isVesselActive(erc20.address, alice))
        })
    })
})

// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "./Dependencies/TrinityBase.sol";
import "./Interfaces/IVesselManagerOperations.sol";

contract VesselManagerOperations is IVesselManagerOperations, UUPSUpgradeable, ReentrancyGuardUpgradeable, TrinityBase {
	string public constant NAME = "VesselManagerOperations";
	uint256 public constant PERCENTAGE_PRECISION = 100_00;
	uint256 public constant BATCH_SIZE_LIMIT = 25;

	uint256 public redemptionSofteningParam;

	// Structs ----------------------------------------------------------------------------------------------------------

	struct HintHelperLocalVars {
		address asset;
		uint256 debtTokenAmount;
		uint256 price;
		uint256 maxIterations;
	}

	// Modifiers --------------------------------------------------------------------------------------------------------

	modifier onlyVesselManager() {
		if (msg.sender != vesselManager) {
			revert VesselManagerOperations__OnlyVesselManager();
		}
		_;
	}

	// Initializer ------------------------------------------------------------------------------------------------------

	function initialize() public initializer {
		__Ownable_init();
		__UUPSUpgradeable_init();
		__ReentrancyGuard_init();
	}

	// Redemption external functions ------------------------------------------------------------------------------------

	function redeemCollateral(
		address _asset,
		uint256 _debtTokenAmount,
		address _upperPartialRedemptionHint,
		address _lowerPartialRedemptionHint,
		address _firstRedemptionHint,
		uint256 _partialRedemptionHintNICR,
		uint256 _maxIterations,
		uint256 _maxFeePercentage
	) external override {
		RedemptionTotals memory totals;
		totals.price = IPriceFeed(priceFeed).fetchPrice(_asset);
		_validateRedemptionRequirements(_asset, _maxFeePercentage, _debtTokenAmount, totals.price);
		totals.totalDebtTokenSupplyAtStart = getEntireSystemDebt(_asset);
		totals.remainingDebt = _debtTokenAmount;
		address currentBorrower;
		if (IVesselManager(vesselManager).isValidFirstRedemptionHint(_asset, _firstRedemptionHint, totals.price)) {
			currentBorrower = _firstRedemptionHint;
		} else {
			currentBorrower = ISortedVessels(sortedVessels).getLast(_asset);
			// Find the first vessel with ICR >= MCR
			while (
				currentBorrower != address(0) &&
				IVesselManager(vesselManager).getCurrentICR(_asset, currentBorrower, totals.price) <
				IAdminContract(adminContract).getMcr(_asset)
			) {
				currentBorrower = ISortedVessels(sortedVessels).getPrev(_asset, currentBorrower);
			}
		}

		// Loop through the vessels starting from the one with lowest collateral ratio until _debtTokenAmount is exchanged for collateral
		if (_maxIterations == 0) {
			_maxIterations = type(uint256).max;
		}
		while (currentBorrower != address(0) && totals.remainingDebt != 0 && _maxIterations != 0) {
			_maxIterations--;
			// Save the address of the vessel preceding the current one, before potentially modifying the list
			address nextUserToCheck = ISortedVessels(sortedVessels).getPrev(_asset, currentBorrower);

			SingleRedemptionValues memory singleRedemption = _redeemCollateralFromVessel(
				_asset,
				currentBorrower,
				totals.remainingDebt,
				totals.price,
				_upperPartialRedemptionHint,
				_lowerPartialRedemptionHint,
				_partialRedemptionHintNICR
			);

			if (singleRedemption.cancelledPartial) break; // Partial redemption was cancelled (out-of-date hint, or new net debt < minimum), therefore we could not redeem from the last vessel

			totals.totalDebtToRedeem = totals.totalDebtToRedeem + singleRedemption.debtLot;
			totals.totalCollDrawn = totals.totalCollDrawn + singleRedemption.collLot;

			totals.remainingDebt = totals.remainingDebt - singleRedemption.debtLot;
			currentBorrower = nextUserToCheck;
		}
		if (totals.totalCollDrawn == 0) {
			revert VesselManagerOperations__UnableToRedeemAnyAmount();
		}

		// Decay the baseRate due to time passed, and then increase it according to the size of this redemption.
		// Use the saved total TRI supply value, from before it was reduced by the redemption.
		IVesselManager(vesselManager).updateBaseRateFromRedemption(
			_asset,
			totals.totalCollDrawn,
			totals.price,
			totals.totalDebtTokenSupplyAtStart
		);

		// Calculate the collateral fee
		totals.collFee = IVesselManager(vesselManager).getRedemptionFee(_asset, totals.totalCollDrawn);

		_requireUserAcceptsFee(totals.collFee, totals.totalCollDrawn, _maxFeePercentage);

		IVesselManager(vesselManager).finalizeRedemption(
			_asset,
			msg.sender,
			totals.totalDebtToRedeem,
			totals.collFee,
			totals.totalCollDrawn
		);

		emit Redemption(_asset, _debtTokenAmount, totals.totalDebtToRedeem, totals.totalCollDrawn, totals.collFee);
	}

	// Hint helper functions --------------------------------------------------------------------------------------------

	/* getRedemptionHints() - Helper function for finding the right hints to pass to redeemCollateral().
	 *
	 * It simulates a redemption of `_debtTokenAmount` to figure out where the redemption sequence will start and what state the final Vessel
	 * of the sequence will end up in.
	 *
	 * Returns three hints:
	 *  - `firstRedemptionHint` is the address of the first Vessel with ICR >= MCR (i.e. the first Vessel that will be redeemed).
	 *  - `partialRedemptionHintNICR` is the final nominal ICR of the last Vessel of the sequence after being hit by partial redemption,
	 *     or zero in case of no partial redemption.
	 *  - `truncatedDebtTokenAmount` is the maximum amount that can be redeemed out of the the provided `_debtTokenAmount`. This can be lower than
	 *    `_debtTokenAmount` when redeeming the full amount would leave the last Vessel of the redemption sequence with less net debt than the
	 *    minimum allowed value (i.e. IAdminContract(adminContract).MIN_NET_DEBT()).
	 *
	 * The number of Vessels to consider for redemption can be capped by passing a non-zero value as `_maxIterations`, while passing zero
	 * will leave it uncapped.
	 */

	function getRedemptionHints(
		address _asset,
		uint256 _debtTokenAmount,
		uint256 _price,
		uint256 _maxIterations
	)
		external
		view
		override
		returns (address firstRedemptionHint, uint256 partialRedemptionHintNewICR, uint256 truncatedDebtTokenAmount)
	{
		HintHelperLocalVars memory vars = HintHelperLocalVars({
			asset: _asset,
			debtTokenAmount: _debtTokenAmount,
			price: _price,
			maxIterations: _maxIterations
		});

		uint256 remainingDebt = _debtTokenAmount;
		address currentVesselBorrower = ISortedVessels(sortedVessels).getLast(vars.asset);

		while (
			currentVesselBorrower != address(0) &&
			IVesselManager(vesselManager).getCurrentICR(vars.asset, currentVesselBorrower, vars.price) <
			IAdminContract(adminContract).getMcr(vars.asset)
		) {
			currentVesselBorrower = ISortedVessels(sortedVessels).getPrev(vars.asset, currentVesselBorrower);
		}

		firstRedemptionHint = currentVesselBorrower;

		if (vars.maxIterations == 0) {
			vars.maxIterations = type(uint256).max;
		}

		while (currentVesselBorrower != address(0) && remainingDebt != 0 && vars.maxIterations-- != 0) {
			uint256 currentVesselNetDebt = _getNetDebt(
				vars.asset,
				IVesselManager(vesselManager).getVesselDebt(vars.asset, currentVesselBorrower)
			);

			if (currentVesselNetDebt <= remainingDebt) {
				remainingDebt = remainingDebt - currentVesselNetDebt;
			} else {
				if (currentVesselNetDebt > IAdminContract(adminContract).getMinNetDebt(vars.asset)) {
					uint256 maxRedeemableDebt = TrinityMath._min(
						remainingDebt,
						currentVesselNetDebt - IAdminContract(adminContract).getMinNetDebt(vars.asset)
					);

					uint256 currentVesselColl = IVesselManager(vesselManager).getVesselColl(vars.asset, currentVesselBorrower);

					uint256 collLot = (maxRedeemableDebt * DECIMAL_PRECISION) / vars.price;
					// Apply redemption softening
					collLot = (collLot * redemptionSofteningParam) / PERCENTAGE_PRECISION;
					uint256 newColl = currentVesselColl - collLot;
					uint256 newDebt = currentVesselNetDebt - maxRedeemableDebt;
					uint256 compositeDebt = _getCompositeDebt(vars.asset, newDebt);

					partialRedemptionHintNewICR = TrinityMath._computeNominalCR(newColl, compositeDebt);
					remainingDebt = remainingDebt - maxRedeemableDebt;
				}

				break;
			}

			currentVesselBorrower = ISortedVessels(sortedVessels).getPrev(vars.asset, currentVesselBorrower);
		}

		truncatedDebtTokenAmount = _debtTokenAmount - remainingDebt;
	}

	/* getApproxHint() - return address of a Vessel that is, on average, (length / numTrials) positions away in the
    sortedVessels list from the correct insert position of the Vessel to be inserted.

    Note: The output address is worst-case O(n) positions away from the correct insert position, however, the function
    is probabilistic. Input can be tuned to guarantee results to a high degree of confidence, e.g:

    Submitting numTrials = k * sqrt(length), with k = 15 makes it very, very likely that the ouput address will
    be <= sqrt(length) positions away from the correct insert position.
    */
	function getApproxHint(
		address _asset,
		uint256 _CR,
		uint256 _numTrials,
		uint256 _inputRandomSeed
	) external view override returns (address hintAddress, uint256 diff, uint256 latestRandomSeed) {
		uint256 arrayLength = IVesselManager(vesselManager).getVesselOwnersCount(_asset);

		if (arrayLength == 0) {
			return (address(0), 0, _inputRandomSeed);
		}

		hintAddress = ISortedVessels(sortedVessels).getLast(_asset);
		diff = TrinityMath._getAbsoluteDifference(_CR, IVesselManager(vesselManager).getNominalICR(_asset, hintAddress));
		latestRandomSeed = _inputRandomSeed;

		uint256 i = 1;

		while (i < _numTrials) {
			latestRandomSeed = uint256(keccak256(abi.encodePacked(latestRandomSeed)));

			uint256 arrayIndex = latestRandomSeed % arrayLength;
			address currentAddress = IVesselManager(vesselManager).getVesselFromVesselOwnersArray(_asset, arrayIndex);
			uint256 currentNICR = IVesselManager(vesselManager).getNominalICR(_asset, currentAddress);

			// check if abs(current - CR) > abs(closest - CR), and update closest if current is closer
			uint256 currentDiff = TrinityMath._getAbsoluteDifference(currentNICR, _CR);

			if (currentDiff < diff) {
				diff = currentDiff;
				hintAddress = currentAddress;
			}
			i++;
		}
	}

	function computeNominalCR(uint256 _coll, uint256 _debt) external pure override returns (uint256) {
		return TrinityMath._computeNominalCR(_coll, _debt);
	}

	// Redemption internal/helper functions -----------------------------------------------------------------------------

	function _validateRedemptionRequirements(
		address _asset,
		uint256 _maxFeePercentage,
		uint256 _debtTokenAmount,
		uint256 _price
	) internal view {
		address redeemer = msg.sender;
		require(IAdminContract(adminContract).getRedeemerIsWhitelisted(redeemer), "VesselManagerOperations: Redeemer not whitelisted");

		uint256 redemptionBlockTimestamp = IAdminContract(adminContract).getRedemptionBlockTimestamp(_asset);
		if (redemptionBlockTimestamp > block.timestamp) {
			revert VesselManagerOperations__RedemptionIsBlocked();
		}
		uint256 redemptionFeeFloor = IAdminContract(adminContract).getRedemptionFeeFloor(_asset);
		if (_maxFeePercentage < redemptionFeeFloor || _maxFeePercentage > DECIMAL_PRECISION) {
			revert VesselManagerOperations__FeePercentOutOfBounds(redemptionFeeFloor, DECIMAL_PRECISION);
		}
		if (_debtTokenAmount == 0) {
			revert VesselManagerOperations__EmptyAmount();
		}
		uint256 redeemerBalance = IDebtToken(debtToken).balanceOf(redeemer);
		if (redeemerBalance < _debtTokenAmount) {
			revert VesselManagerOperations__InsufficientDebtTokenBalance(redeemerBalance);
		}
		uint256 tcr = _getTCR(_asset, _price);
		uint256 mcr = IAdminContract(adminContract).getMcr(_asset);
		if (tcr < mcr) {
			revert VesselManagerOperations__TCRMustBeAboveMCR(tcr, mcr);
		}
	}

	// Redeem as much collateral as possible from _borrower's vessel in exchange for TRI up to _maxDebtTokenAmount
	function _redeemCollateralFromVessel(
		address _asset,
		address _borrower,
		uint256 _maxDebtTokenAmount,
		uint256 _price,
		address _upperPartialRedemptionHint,
		address _lowerPartialRedemptionHint,
		uint256 _partialRedemptionHintNICR
	) internal returns (SingleRedemptionValues memory singleRedemption) {
		uint256 vesselDebt = IVesselManager(vesselManager).getVesselDebt(_asset, _borrower);
		uint256 vesselColl = IVesselManager(vesselManager).getVesselColl(_asset, _borrower);

		// Determine the remaining amount (lot) to be redeemed, capped by the entire debt of the vessel minus the liquidation reserve
		singleRedemption.debtLot = TrinityMath._min(
			_maxDebtTokenAmount,
			vesselDebt - IAdminContract(adminContract).getDebtTokenGasCompensation(_asset)
		);

		// Get the debtToken lot of equivalent value in USD
		singleRedemption.collLot = (singleRedemption.debtLot * DECIMAL_PRECISION) / _price;

		// Apply redemption softening
		singleRedemption.collLot = (singleRedemption.collLot * redemptionSofteningParam) / PERCENTAGE_PRECISION;

		// Decrease the debt and collateral of the current vessel according to the debt token lot and corresponding coll to send

		uint256 newDebt = vesselDebt - singleRedemption.debtLot;
		uint256 newColl = vesselColl - singleRedemption.collLot;

		if (newDebt == IAdminContract(adminContract).getDebtTokenGasCompensation(_asset)) {
			IVesselManager(vesselManager).executeFullRedemption(_asset, _borrower, newColl);
		} else {
			uint256 newNICR = TrinityMath._computeNominalCR(newColl, newDebt);

			/*
			 * If the provided hint is out of date, we bail since trying to reinsert without a good hint will almost
			 * certainly result in running out of gas.
			 *
			 * If the resultant net debt of the partial is less than the minimum, net debt we bail.
			 */
			if (
				newNICR != _partialRedemptionHintNICR ||
				_getNetDebt(_asset, newDebt) < IAdminContract(adminContract).getMinNetDebt(_asset)
			) {
				singleRedemption.cancelledPartial = true;
				return singleRedemption;
			}

			IVesselManager(vesselManager).executePartialRedemption(
				_asset,
				_borrower,
				newDebt,
				newColl,
				newNICR,
				_upperPartialRedemptionHint,
				_lowerPartialRedemptionHint
			);
		}

		return singleRedemption;
	}

	function setRedemptionSofteningParam(uint256 _redemptionSofteningParam) public {
		if (msg.sender != timelockAddress) {
			revert VesselManagerOperations__NotTimelock();
		}
		if (_redemptionSofteningParam < 9700 || _redemptionSofteningParam > PERCENTAGE_PRECISION) {
			revert VesselManagerOperations__InvalidParam();
		}
		redemptionSofteningParam = _redemptionSofteningParam;
		emit RedemptionSoftenParamChanged(_redemptionSofteningParam);
	}

	function authorizeUpgrade(address newImplementation) public {
		_authorizeUpgrade(newImplementation);
	}

	function _authorizeUpgrade(address) internal override onlyOwner {}
}

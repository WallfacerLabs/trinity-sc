// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "./Dependencies/TrinityBase.sol";
import "./Interfaces/IVesselManager.sol";

contract VesselManager is IVesselManager, UUPSUpgradeable, ReentrancyGuardUpgradeable, TrinityBase {
	// Constants ------------------------------------------------------------------------------------------------------

	string public constant NAME = "VesselManager";

	uint256 public constant SECONDS_IN_ONE_MINUTE = 60;
	/*
	 * Half-life of 12h. 12h = 720 min
	 * (1/2) = d^720 => d = (1/2)^(1/720)
	 */
	uint256 public constant MINUTE_DECAY_FACTOR = 999037758833783000;

	/*
	 * BETA: 18 digit decimal. Parameter by which to divide the redeemed fraction, in order to calc the new base rate from a redemption.
	 * Corresponds to (1 / ALPHA) in the white paper.
	 */
	uint256 public constant BETA = 2;

	// State ----------------------------------------------------------------------------------------------------------

	mapping(address => uint256) public baseRate;

	// The timestamp of the latest fee operation (redemption or new debt token issuance)
	mapping(address => uint256) public lastFeeOperationTime;

	// Vessels[borrower address][Collateral address]
	mapping(address => mapping(address => Vessel)) public Vessels;

	// Array of all active vessel addresses - used to to compute an approximate hint off-chain, for the sorted list insertion
	mapping(address => address[]) public VesselOwners;

	// Error trackers for the vessel redistribution calculation
	mapping(address => uint256) public lastCollError_Redistribution;
	mapping(address => uint256) public lastDebtError_Redistribution;

	bool public isSetupInitialized;

	// Modifiers ------------------------------------------------------------------------------------------------------

	modifier onlyVesselManagerOperations() {
		if (msg.sender != vesselManagerOperations) {
			revert VesselManager__OnlyVesselManagerOperations();
		}
		_;
	}

	modifier onlyBorrowerOperations() {
		if (msg.sender != borrowerOperations) {
			revert VesselManager__OnlyBorrowerOperations();
		}
		_;
	}

	modifier onlyVesselManagerOperationsOrBorrowerOperations() {
		if (msg.sender != borrowerOperations && msg.sender != vesselManagerOperations) {
			revert VesselManager__OnlyVesselManagerOperationsOrBorrowerOperations();
		}
		_;
	}

	// Initializer ------------------------------------------------------------------------------------------------------

	function initialize() public initializer {
		__Ownable_init();
		__UUPSUpgradeable_init();
		__ReentrancyGuard_init();
	}

	// External/public functions --------------------------------------------------------------------------------------

	function isValidFirstRedemptionHint(
		address _asset,
		address _firstRedemptionHint,
		uint256 _price
	) external view returns (bool) {
		if (
			_firstRedemptionHint == address(0) ||
			!ISortedVessels(sortedVessels).contains(_asset, _firstRedemptionHint) ||
			getCurrentICR(_asset, _firstRedemptionHint, _price) < IAdminContract(adminContract).getMcr(_asset)
		) {
			return false;
		}
		address nextVessel = ISortedVessels(sortedVessels).getNext(_asset, _firstRedemptionHint);
		return
			nextVessel == address(0) ||
			getCurrentICR(_asset, nextVessel, _price) < IAdminContract(adminContract).getMcr(_asset);
	}

	// Return the nominal collateral ratio (ICR) of a given Vessel, without the price. Takes a vessel's pending coll and debt rewards from redistributions into account.
	function getNominalICR(address _asset, address _borrower) external view override returns (uint256) {
		(uint256 currentAsset, uint256 currentDebt) = _getCurrentVesselAmounts(_asset, _borrower);

		uint256 NICR = TrinityMath._computeNominalCR(currentAsset, currentDebt);
		return NICR;
	}

	// Return the current collateral ratio (ICR) of a given Vessel. Takes a vessel's pending coll and debt rewards from redistributions into account.
	function getCurrentICR(address _asset, address _borrower, uint256 _price) public view override returns (uint256) {
		(uint256 currentAsset, uint256 currentDebt) = _getCurrentVesselAmounts(_asset, _borrower);
		uint256 ICR = TrinityMath._computeCR(currentAsset, currentDebt, _price);
		return ICR;
	}

	function getEntireDebtAndColl(
		address _asset,
		address _borrower
	) external view override returns (uint256 debt, uint256 coll, uint256 pendingDebtReward, uint256 pendingCollReward) {
		Vessel storage vessel = Vessels[_borrower][_asset];
		debt = vessel.debt;
		coll = vessel.coll;
	}

	function isVesselActive(address _asset, address _borrower) public view override returns (bool) {
		return getVesselStatus(_asset, _borrower) == uint256(Status.active);
	}

	function getTCR(address _asset, uint256 _price) external view override returns (uint256) {
		return _getTCR(_asset, _price);
	}

	function checkRecoveryMode(address _asset, uint256 _price) external view override returns (bool) {
		return _checkRecoveryMode(_asset, _price);
	}

	function getBorrowingRate(address _asset) external view override returns (uint256) {
		return IAdminContract(adminContract).getBorrowingFee(_asset);
	}

	function getBorrowingFee(address _asset, uint256 _debt) external view override returns (uint256) {
		return (IAdminContract(adminContract).getBorrowingFee(_asset) * _debt) / DECIMAL_PRECISION;
	}

	function getRedemptionFee(address _asset, uint256 _assetDraw) public view returns (uint256) {
		return _calcRedemptionFee(getRedemptionRate(_asset), _assetDraw);
	}

	function getRedemptionFeeWithDecay(address _asset, uint256 _assetDraw) external view override returns (uint256) {
		return _calcRedemptionFee(getRedemptionRateWithDecay(_asset), _assetDraw);
	}

	function getRedemptionRate(address _asset) public view override returns (uint256) {
		return _calcRedemptionRate(_asset, baseRate[_asset]);
	}

	function getRedemptionRateWithDecay(address _asset) public view override returns (uint256) {
		return _calcRedemptionRate(_asset, _calcDecayedBaseRate(_asset));
	}

	// Called by Trinity contracts ------------------------------------------------------------------------------------

	function addVesselOwnerToArray(
		address _asset,
		address _borrower
	) external override onlyBorrowerOperations returns (uint256 index) {
		address[] storage assetOwners = VesselOwners[_asset];
		assetOwners.push(_borrower);
		index = assetOwners.length - 1;
		Vessels[_borrower][_asset].arrayIndex = uint128(index);
		return index;
	}

	function executeFullRedemption(
		address _asset,
		address _borrower,
		uint256 _newColl
	) external override nonReentrant onlyVesselManagerOperations {
		_closeVessel(_asset, _borrower, Status.closedByRedemption);
		_redeemCloseVessel(_asset, _borrower, IAdminContract(adminContract).getDebtTokenGasCompensation(_asset), _newColl);
		emit VesselUpdated(_asset, _borrower, 0, 0, 0, VesselManagerOperation.redeemCollateral);
	}

	function executePartialRedemption(
		address _asset,
		address _borrower,
		uint256 _newDebt,
		uint256 _newColl,
		uint256 _newNICR,
		address _upperPartialRedemptionHint,
		address _lowerPartialRedemptionHint
	) external override onlyVesselManagerOperations {
		ISortedVessels(sortedVessels).reInsert(
			_asset,
			_borrower,
			_newNICR,
			_upperPartialRedemptionHint,
			_lowerPartialRedemptionHint
		);

		Vessel storage vessel = Vessels[_borrower][_asset];
		vessel.debt = _newDebt;
		vessel.coll = _newColl;

		emit VesselUpdated(_asset, _borrower, _newDebt, _newColl, vessel.stake, VesselManagerOperation.redeemCollateral);
	}

	function finalizeRedemption(
		address _asset,
		address _receiver,
		uint256 _debtToRedeem,
		uint256 _assetFeeAmount,
		uint256 _assetRedeemedAmount
	) external override onlyVesselManagerOperations {
		// Send the asset fee
		if (_assetFeeAmount != 0) {
			IActivePool(activePool).sendAsset(_asset, treasuryAddress, _assetFeeAmount);
			emit RedemptionFeeCollected(_asset, _assetFeeAmount);
		}
		// Burn the total debt tokens that is cancelled with debt, and send the redeemed asset to msg.sender
		IDebtToken(debtToken).burn(_receiver, _debtToRedeem);
		// Update Active Pool, and send asset to account
		uint256 collToSendToRedeemer = _assetRedeemedAmount - _assetFeeAmount;
		IActivePool(activePool).decreaseDebt(_asset, _debtToRedeem);
		IActivePool(activePool).sendAsset(_asset, _receiver, collToSendToRedeemer);
	}

	function updateBaseRateFromRedemption(
		address _asset,
		uint256 _assetDrawn,
		uint256 _price,
		uint256 _totalDebtTokenSupply
	) external override onlyVesselManagerOperations returns (uint256) {
		uint256 newBaseRate = 0;

		if(IAdminContract(adminContract).getRedemptionBaseFeeEnabled(_asset)) {
			uint256 decayedBaseRate = _calcDecayedBaseRate(_asset);
			uint256 redeemedDebtFraction = (_assetDrawn * _price) / _totalDebtTokenSupply;
			newBaseRate = decayedBaseRate + (redeemedDebtFraction / BETA);
			newBaseRate = TrinityMath._min(newBaseRate, DECIMAL_PRECISION);
			assert(newBaseRate != 0);
		}

		baseRate[_asset] = newBaseRate;
		emit BaseRateUpdated(_asset, newBaseRate);
		_updateLastFeeOpTime(_asset);
		return newBaseRate;
	}

	function closeVessel(
		address _asset,
		address _borrower
	) external override onlyVesselManagerOperationsOrBorrowerOperations {
		return _closeVessel(_asset, _borrower, Status.closedByOwner);
	}

	function sendGasCompensation(
		address _asset,
		address _liquidator,
		uint256 _debtTokenAmount,
		uint256 _assetAmount
	) external nonReentrant onlyVesselManagerOperations {
		if (_debtTokenAmount != 0) {
			IDebtToken(debtToken).returnFromPool(gasPoolAddress, _liquidator, _debtTokenAmount);
		}
		if (_assetAmount != 0) {
			IActivePool(activePool).sendAsset(_asset, _liquidator, _assetAmount);
		}
	}

	// Internal functions ---------------------------------------------------------------------------------------------

	function _redeemCloseVessel(
		address _asset,
		address _borrower,
		uint256 _debtTokenAmount,
		uint256 _assetAmount
	) internal {
		IDebtToken(debtToken).burn(gasPoolAddress, _debtTokenAmount);
		// Update Active Pool, and send asset to account
		IActivePool(activePool).decreaseDebt(_asset, _debtTokenAmount);
		// send asset from Active Pool to CollSurplus Pool
		ICollSurplusPool(collSurplusPool).accountSurplus(_asset, _borrower, _assetAmount);
		IActivePool(activePool).sendAsset(_asset, collSurplusPool, _assetAmount);
	}

	function _getCurrentVesselAmounts(
		address _asset,
		address _borrower
	) internal view returns (uint256 coll, uint256 debt) {
		Vessel memory vessel = Vessels[_borrower][_asset];
		coll = vessel.coll;
		debt = vessel.debt;
	}

	function _closeVessel(address _asset, address _borrower, Status closedStatus) internal {
		assert(closedStatus != Status.nonExistent && closedStatus != Status.active);

		uint256 VesselOwnersArrayLength = VesselOwners[_asset].length;
		if (VesselOwnersArrayLength <= 1 || ISortedVessels(sortedVessels).getSize(_asset) <= 1) {
			revert VesselManager__OnlyOneVessel();
		}

		Vessel storage vessel = Vessels[_borrower][_asset];
		vessel.status = closedStatus;
		vessel.coll = 0;
		vessel.debt = 0;

		_removeVesselOwner(_asset, _borrower, VesselOwnersArrayLength);
		ISortedVessels(sortedVessels).remove(_asset, _borrower);
	}

	function _removeVesselOwner(address _asset, address _borrower, uint256 VesselOwnersArrayLength) internal {
		Vessel memory vessel = Vessels[_borrower][_asset];
		assert(vessel.status != Status.nonExistent && vessel.status != Status.active);

		uint128 index = vessel.arrayIndex;
		uint256 length = VesselOwnersArrayLength;
		uint256 idxLast = length - 1;

		assert(index <= idxLast);

		address[] storage vesselAssetOwners = VesselOwners[_asset];
		address addressToMove = vesselAssetOwners[idxLast];

		vesselAssetOwners[index] = addressToMove;
		Vessels[addressToMove][_asset].arrayIndex = index;
		emit VesselIndexUpdated(_asset, addressToMove, index);

		vesselAssetOwners.pop();
	}

	function _calcRedemptionRate(address _asset, uint256 _baseRate) internal view returns (uint256) {
		return TrinityMath._min(IAdminContract(adminContract).getRedemptionFeeFloor(_asset) + _baseRate, DECIMAL_PRECISION);
	}

	function _calcRedemptionFee(uint256 _redemptionRate, uint256 _assetDraw) internal pure returns (uint256) {
		uint256 redemptionFee = (_redemptionRate * _assetDraw) / DECIMAL_PRECISION;
		if (redemptionFee >= _assetDraw) {
			revert VesselManager__FeeBiggerThanAssetDraw();
		}
		return redemptionFee;
	}

	function _updateLastFeeOpTime(address _asset) internal {
		uint256 timePassed = block.timestamp - lastFeeOperationTime[_asset];
		if (timePassed >= SECONDS_IN_ONE_MINUTE) {
			// Update the last fee operation time only if time passed >= decay interval. This prevents base rate griefing.
			lastFeeOperationTime[_asset] = block.timestamp;
			emit LastFeeOpTimeUpdated(_asset, block.timestamp);
		}
	}

	function _calcDecayedBaseRate(address _asset) internal view returns (uint256) {
		uint256 minutesPassed = _minutesPassedSinceLastFeeOp(_asset);
		uint256 decayFactor = TrinityMath._decPow(MINUTE_DECAY_FACTOR, minutesPassed);
		return (baseRate[_asset] * decayFactor) / DECIMAL_PRECISION;
	}

	function _minutesPassedSinceLastFeeOp(address _asset) internal view returns (uint256) {
		return (block.timestamp - lastFeeOperationTime[_asset]) / SECONDS_IN_ONE_MINUTE;
	}

	// --- Vessel property getters --------------------------------------------------------------------------------------

	function getVesselStatus(address _asset, address _borrower) public view override returns (uint256) {
		return uint256(Vessels[_borrower][_asset].status);
	}

	function getVesselStake(address _asset, address _borrower) external view override returns (uint256) {
		return Vessels[_borrower][_asset].stake;
	}

	function getVesselDebt(address _asset, address _borrower) external view override returns (uint256) {
		return Vessels[_borrower][_asset].debt;
	}

	function getVesselColl(address _asset, address _borrower) external view override returns (uint256) {
		return Vessels[_borrower][_asset].coll;
	}

	function getVesselOwnersCount(address _asset) external view override returns (uint256) {
		return VesselOwners[_asset].length;
	}

	function getVesselFromVesselOwnersArray(address _asset, uint256 _index) external view override returns (address) {
		return VesselOwners[_asset][_index];
	}

	// --- Vessel property setters, called by Trinity's BorrowerOperations/VMRedemptions/VMLiquidations ---------------

	function setVesselStatus(address _asset, address _borrower, uint256 _num) external override onlyBorrowerOperations {
		Vessels[_borrower][_asset].status = Status(_num);
	}

	function increaseVesselColl(
		address _asset,
		address _borrower,
		uint256 _collIncrease
	) external override onlyBorrowerOperations returns (uint256 newColl) {
		Vessel storage vessel = Vessels[_borrower][_asset];
		newColl = vessel.coll + _collIncrease;
		vessel.coll = newColl;
	}

	function decreaseVesselColl(
		address _asset,
		address _borrower,
		uint256 _collDecrease
	) external override onlyBorrowerOperations returns (uint256 newColl) {
		Vessel storage vessel = Vessels[_borrower][_asset];
		newColl = vessel.coll - _collDecrease;
		vessel.coll = newColl;
	}

	function increaseVesselDebt(
		address _asset,
		address _borrower,
		uint256 _debtIncrease
	) external override onlyBorrowerOperations returns (uint256 newDebt) {
		Vessel storage vessel = Vessels[_borrower][_asset];
		newDebt = vessel.debt + _debtIncrease;
		vessel.debt = newDebt;
	}

	function decreaseVesselDebt(
		address _asset,
		address _borrower,
		uint256 _debtDecrease
	) external override onlyBorrowerOperations returns (uint256) {
		Vessel storage vessel = Vessels[_borrower][_asset];
		uint256 oldDebt = vessel.debt;
		if (_debtDecrease == 0) {
			return oldDebt; // no changes
		}
		uint256 newDebt = oldDebt - _debtDecrease;
		vessel.debt = newDebt;
		return newDebt;
	}

	function authorizeUpgrade(address newImplementation) public {
		_authorizeUpgrade(newImplementation);
	}

	function _authorizeUpgrade(address) internal override onlyOwner {}
}


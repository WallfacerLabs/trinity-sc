// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "./Interfaces/IAdminContract.sol";
import "./Interfaces/IStabilityPool.sol";
import "./Interfaces/IActivePool.sol";
import "./Interfaces/IDefaultPool.sol";
import "./Addresses.sol";

contract AdminContract is IAdminContract, UUPSUpgradeable, OwnableUpgradeable, Addresses {
	// Constants --------------------------------------------------------------------------------------------------------

	string public constant NAME = "AdminContract";

	uint256 public constant DECIMAL_PRECISION = 1 ether;
	uint256 public constant _100pct = 1 ether; // 1e18 == 100%
	uint256 private constant DEFAULT_DECIMALS = 18;

	uint256 public constant BORROWING_FEE_DEFAULT = 383_561_643_835_616; // 2% * (7 / 365)
	uint256 public constant CCR_DEFAULT = 0; // 0%
	uint256 public constant MCR_DEFAULT = 1_052_631_578_947_368_421; // 1 / 0.95
	uint256 public constant MIN_NET_DEBT_DEFAULT = 2_000 ether;
	uint256 public constant MINT_CAP_DEFAULT = 1_000_000 ether; // 1 million TRI
	uint256 public constant REDEMPTION_FEE_FLOOR_DEFAULT = 0; // 0%
	uint256 public constant REDEMPTION_BLOCK_TIMESTAMP_DEFAULT = type(uint256).max; // never
	bool public constant REDEMPTION_BASE_FEE_ENABLED_DEFAULT = false;

	// State ------------------------------------------------------------------------------------------------------------

	/**
		@dev Cannot be public as struct has too many variables for the stack.
		@dev Create special view structs/getters instead.
	 */
	mapping(address => CollateralParams) internal collateralParams;

	mapping(address => mapping(address => bool)) internal collateralWhitelistedAddresses;

	mapping(address => bool) internal whitelistedLiquidators;

	// list of all collateral types in collateralParams (active and deprecated)
	// Addresses for easy access
	address[] public validCollateral; // index maps to token address.

	bool public isSetupInitialized;

	// Modifiers --------------------------------------------------------------------------------------------------------

	// Require that the collateral exists in the controller. If it is not the 0th index, and the
	// index is still 0 then it does not exist in the mapping.
	// no require here for valid collateral 0 index because that means it exists.
	modifier exists(address _collateral) {
		_exists(_collateral);
		_;
	}

	modifier onlyTimelock() {
		if (isSetupInitialized) {
			if (msg.sender != timelockAddress) {
				revert AdminContract__OnlyTimelock();
			}
		} else {
			if (msg.sender != owner()) {
				revert AdminContract__OnlyOwner();
			}
		}
		_;
	}

	modifier safeCheck(
		string memory parameter,
		address _collateral,
		uint256 enteredValue,
		uint256 min,
		uint256 max
	) {
		require(collateralParams[_collateral].active, "Collateral is not configured, use setCollateralParameters");

		if (enteredValue < min || enteredValue > max) {
			revert SafeCheckError(parameter, enteredValue, min, max);
		}
		_;
	}

	// Initializers -----------------------------------------------------------------------------------------------------

	function initialize() public initializer {
		__Ownable_init();
		__UUPSUpgradeable_init();
	}

	/**
	 * @dev The deployment script will call this function when all initial collaterals have been configured;
	 *      after this is set to true, all subsequent config/setters will need to go through the timelocks.
	 */
	function setSetupIsInitialized() external onlyTimelock {
		isSetupInitialized = true;
	}

	// External Functions -----------------------------------------------------------------------------------------------

	function addNewCollateral(
		address _collateral,
		uint256 _decimals
	) external override onlyTimelock {
		require(collateralParams[_collateral].mcr == 0, "collateral already exists");
		require(_decimals == DEFAULT_DECIMALS, "collaterals must have the default decimals");
		validCollateral.push(_collateral);
		collateralParams[_collateral] = CollateralParams({
			decimals: _decimals,
			index: validCollateral.length - 1,
			active: false,
			borrowingFee: BORROWING_FEE_DEFAULT,
			ccr: CCR_DEFAULT,
			mcr: MCR_DEFAULT,
			minNetDebt: MIN_NET_DEBT_DEFAULT,
			mintCap: MINT_CAP_DEFAULT,
			redemptionFeeFloor: REDEMPTION_FEE_FLOOR_DEFAULT,
			redemptionBlockTimestamp: REDEMPTION_BLOCK_TIMESTAMP_DEFAULT,
			redemptionBaseFeeEnabled: REDEMPTION_BASE_FEE_ENABLED_DEFAULT
		});

		IStabilityPool(stabilityPool).addCollateralType(_collateral);

		// throw event
		emit CollateralAdded(_collateral);
	}

	function setCollateralParameters(
		address _collateral,
		uint256 borrowingFee,
		uint256 ccr,
		uint256 mcr,
		uint256 minNetDebt,
		uint256 mintCap,
		uint256 redemptionFeeFloor
	) public override onlyTimelock {
		collateralParams[_collateral].active = true;
		setBorrowingFee(_collateral, borrowingFee);
		setCCR(_collateral, ccr);
		setMCR(_collateral, mcr);
		setMinNetDebt(_collateral, minNetDebt);
		setMintCap(_collateral, mintCap);
		setRedemptionFeeFloor(_collateral, redemptionFeeFloor);
	}

	function setIsActive(address _collateral, bool _active) external onlyTimelock {
		CollateralParams storage collParams = collateralParams[_collateral];
		collParams.active = _active;
	}

	function setBorrowingFee(
		address _collateral,
		uint256 borrowingFee
	)
		public
		override
		onlyTimelock
		safeCheck("Borrowing Fee", _collateral, borrowingFee, 0, 0.1 ether) // 0% - 10%
	{
		CollateralParams storage collParams = collateralParams[_collateral];
		uint256 oldBorrowing = collParams.borrowingFee;
		collParams.borrowingFee = borrowingFee;
		emit BorrowingFeeChanged(oldBorrowing, borrowingFee);
	}

	function setCCR(
		address _collateral,
		uint256 newCCR
	)
		public
		override
		onlyTimelock
		safeCheck("CCR", _collateral, newCCR, 0, 10 ether) // 0% - 1,000%
	{
		CollateralParams storage collParams = collateralParams[_collateral];
		uint256 oldCCR = collParams.ccr;
		collParams.ccr = newCCR;
		emit CCRChanged(oldCCR, newCCR);
	}

	function setMCR(
		address _collateral,
		uint256 newMCR
	)
		public
		override
		onlyTimelock
		safeCheck("MCR", _collateral, newMCR, 1.01 ether, 10 ether) // 101% - 1,000%
	{
		CollateralParams storage collParams = collateralParams[_collateral];
		uint256 oldMCR = collParams.mcr;
		collParams.mcr = newMCR;
		emit MCRChanged(oldMCR, newMCR);
	}

	function setMinNetDebt(
		address _collateral,
		uint256 minNetDebt
	) public override onlyTimelock safeCheck("Min Net Debt", _collateral, minNetDebt, 0, 2_000 ether) {
		CollateralParams storage collParams = collateralParams[_collateral];
		uint256 oldMinNet = collParams.minNetDebt;
		collParams.minNetDebt = minNetDebt;
		emit MinNetDebtChanged(oldMinNet, minNetDebt);
	}

	function setMintCap(address _collateral, uint256 mintCap) public override onlyTimelock {
		CollateralParams storage collParams = collateralParams[_collateral];
		uint256 oldMintCap = collParams.mintCap;
		collParams.mintCap = mintCap;
		emit MintCapChanged(oldMintCap, mintCap);
	}

	function setRedemptionFeeFloor(
		address _collateral,
		uint256 redemptionFeeFloor
	)
		public
		override
		onlyTimelock
		safeCheck("Redemption Fee Floor", _collateral, redemptionFeeFloor, 0, 0.1 ether) // 0% - 10%
	{
		CollateralParams storage collParams = collateralParams[_collateral];
		uint256 oldRedemptionFeeFloor = collParams.redemptionFeeFloor;
		collParams.redemptionFeeFloor = redemptionFeeFloor;
		emit RedemptionFeeFloorChanged(oldRedemptionFeeFloor, redemptionFeeFloor);
	}

	function setRedemptionBlockTimestamp(address _collateral, uint256 _blockTimestamp) public override onlyTimelock {
		collateralParams[_collateral].redemptionBlockTimestamp = _blockTimestamp;
		emit RedemptionBlockTimestampChanged(_collateral, _blockTimestamp);
	}

	function setAddressCollateralWhitelisted(
		address _collateral,
		address _address,
		bool _whitelisted
	) external onlyTimelock {
		collateralWhitelistedAddresses[_collateral][_address] = _whitelisted;
		emit AddressCollateralWhitelisted(_collateral, _address, _whitelisted);
	}

	function setLiquidatorWhitelisted(address _liquidator, bool _whitelisted) external onlyTimelock {
		whitelistedLiquidators[_liquidator] = _whitelisted;
		emit LiquidatorWhitelisted(_liquidator, _whitelisted);
	}

	function setRedemptionBaseFeeEnabled(address _collateral, bool _enabled) external onlyTimelock {
		collateralParams[_collateral].redemptionBaseFeeEnabled = _enabled;
		emit BaseFeeEnabledChanged(_collateral, _enabled);
	}

	// View functions ---------------------------------------------------------------------------------------------------

	function getValidCollateral() external view override returns (address[] memory) {
		return validCollateral;
	}

	function getIsActive(address _collateral) external view override exists(_collateral) returns (bool) {
		return collateralParams[_collateral].active;
	}

	function getDecimals(address _collateral) external view exists(_collateral) returns (uint256) {
		return collateralParams[_collateral].decimals;
	}

	function getIndex(address _collateral) external view override exists(_collateral) returns (uint256) {
		return (collateralParams[_collateral].index);
	}

	function getIndices(address[] memory _colls) external view returns (uint256[] memory indices) {
		uint256 len = _colls.length;
		indices = new uint256[](len);

		for (uint256 i; i < len; ) {
			_exists(_colls[i]);
			indices[i] = collateralParams[_colls[i]].index;
			unchecked {
				i++;
			}
		}
	}

	function getMcr(address _collateral) external view override returns (uint256) {
		return collateralParams[_collateral].mcr;
	}

	function getCcr(address _collateral) external view override returns (uint256) {
		return collateralParams[_collateral].ccr;
	}

	function getMinNetDebt(address _collateral) external view override returns (uint256) {
		return collateralParams[_collateral].minNetDebt;
	}

	function getBorrowingFee(address _collateral) external view override returns (uint256) {
		return collateralParams[_collateral].borrowingFee;
	}

	function getRedemptionFeeFloor(address _collateral) external view override returns (uint256) {
		return collateralParams[_collateral].redemptionFeeFloor;
	}

	function getRedemptionBlockTimestamp(address _collateral) external view override returns (uint256) {
		return collateralParams[_collateral].redemptionBlockTimestamp;
	}

	function getMintCap(address _collateral) external view override returns (uint256) {
		return collateralParams[_collateral].mintCap;
	}

	function getTotalAssetDebt(address _asset) external view override returns (uint256) {
		return IActivePool(activePool).getDebtTokenBalance(_asset) + IDefaultPool(defaultPool).getDebtTokenBalance(_asset);
	}

	function getIsAddressCollateralWhitelisted(address _collateral, address _address) external view returns (bool) {
		return collateralWhitelistedAddresses[_collateral][_address];
	}

	function getIsLiquidatorWhitelisted(address _liquidator) external view returns (bool) {
		return whitelistedLiquidators[_liquidator];
	}

	function getRedemptionBaseFeeEnabled(address _collateral) external view override returns (bool) {
		return collateralParams[_collateral].redemptionBaseFeeEnabled;
	}

	// Internal Functions -----------------------------------------------------------------------------------------------

	function _exists(address _collateral) internal view {
		require(collateralParams[_collateral].mcr != 0, "collateral does not exist");
	}

	function authorizeUpgrade(address newImplementation) public {
		_authorizeUpgrade(newImplementation);
	}

	function _authorizeUpgrade(address) internal override onlyOwner {}
}

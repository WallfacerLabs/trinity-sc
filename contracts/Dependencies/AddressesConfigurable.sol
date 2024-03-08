// SPDX-License-Identifier: MIT

pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

abstract contract AddressesConfigurable is OwnableUpgradeable {
	address public activePool;
	address public adminContract;
	address public borrowerOperations;
	address public collSurplusPool;
	address public debtToken;
	address public defaultPool;
	address public gasPoolAddress;
	address public priceFeed;
	address public sortedVessels;
	address public stabilityPool;
	address public timelockAddress;
	address public treasuryAddress;
	address public vesselManager;
	address public vesselManagerOperations;

	bool public isAddressSetupInitialized;

	/**
	 * @dev This empty reserved space is put in place to allow future versions to add new
	 * variables without shifting down storage in the inheritance chain.
	 * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
	 */
	uint256[33] private __gap; // Goerli uses 47; Arbitrum uses 33

	// Dependency setters -----------------------------------------------------------------------------------------------

	function setAddresses(address[] calldata _addresses) external onlyOwner {
		require(!isAddressSetupInitialized, "Setup is already initialized");
		require(_addresses.length == 14, "Expected 14 addresses at setup");
		for (uint i = 0; i < 14; i++) {
			require(_addresses[i] != address(0), "Invalid address");
		}
		activePool = _addresses[0];
		adminContract = _addresses[1];
		borrowerOperations = _addresses[2];
		collSurplusPool = _addresses[3];
		debtToken = _addresses[4];
		defaultPool = _addresses[5];
		gasPoolAddress = _addresses[6];
		priceFeed = _addresses[7];
		sortedVessels = _addresses[8];
		stabilityPool = _addresses[9];
		timelockAddress = _addresses[10];
		treasuryAddress = _addresses[11];
		vesselManager = _addresses[12];
		vesselManagerOperations = _addresses[13];

		isAddressSetupInitialized = true;
	}
}


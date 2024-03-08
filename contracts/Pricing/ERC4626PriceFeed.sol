// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../Interfaces/IPriceFeed.sol";
import "../Interfaces/IERC4626.sol";

contract ERC4626PriceFeed is IPriceFeed {
    string public constant NAME = "ERC4626PriceFeed";

    mapping(address => uint256) public prices;

    function getPrice(address _asset) external view returns (uint256) {
        return _getPrice(_asset);
    }

    function _getPrice(address _asset) internal view returns (uint256) {
        return IERC4626(_asset).convertToAssets(1e18);
    }

    function setOracle(
        address _token,
        address _oracle,
        ProviderType _type,
        uint256 _timeoutMinutes,
        bool _isEthIndexed,
        bool _isFallback
    ) external override {}

    function fetchPrice(address _asset) external view override returns (uint256) {
        return _getPrice(_asset);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

interface IGateU {
    function isOpen() external view returns (bool);
}

/// @title Minter (fixture, route A destination side, Unichain Sepolia)
/// @notice Mints the wrapped token when the relayer reports a lock. A compromised relayer key is the attack the
///         fixture stages: a mint whose lock never happened. Every mint checks gate U.
/// @dev Spike version: relayer-address check only (signature + seize arrive with the core flow).
contract Minter {
    uint256 public constant MAX_PER_MSG = 500e18;

    address public immutable owner;
    address public relayer;
    IGateU public immutable gate;
    mapping(uint64 => bool) public mintedNonce;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    event Minted(uint64 indexed nonce, address indexed to, uint256 amount);

    error GatePaused();
    error OverCap();
    error NotRelayer();
    error NonceUsed();

    constructor(address gate_, address relayer_) {
        owner = msg.sender;
        gate = IGateU(gate_);
        relayer = relayer_;
    }

    function mint(uint64 lockNonce, address to, uint256 amount) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (!gate.isOpen()) revert GatePaused();
        if (amount > MAX_PER_MSG) revert OverCap();
        if (mintedNonce[lockNonce]) revert NonceUsed();
        mintedNonce[lockNonce] = true;
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Minted(lockNonce, to, amount);
    }
}

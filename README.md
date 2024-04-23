# Trinity: Decentralized Borrowing Protocol

Trinity is a decentralized protocol that allows Ether or liquid staking derivatives (LSDs) holders to obtain maximum liquidity against
their collateral without paying interest. 

## Table of Content <!-- omit in toc -->
- [Trinity: Decentralized Borrowing Protocol](#trinity-decentralized-borrowing-protocol)
  - [Overview](#overview)
  - [Core System Architecture](#core-system-architecture)
    - [Core Smart Contracts](#core-smart-contracts)
    - [Data and Value Silo Contracts](#data-and-value-silo-contracts)
  - [Smart Contract changes from Vesta](#smart-contract-changes-from-vesta)
  - [Development](#development)
    - [Clone \& Install](#clone--install)
    - [Deploy to a local node](#deploy-to-a-local-node)
  - [Running Tests](#running-tests)
    - [Hardhat](#hardhat)

***

## Overview

Trinity is based on [Liquity](https://github.com/liquity/dev), which introduced a fully decentralized borrowing protocol for eth. It is suggested to start from there to understand the underlying mechanisms of the protocol. 

Liquity had many forks, which expanded on the original design (e.g. allowing multiple ERC-20 tokens as collateral).
Trinity took inspiration from two in particular:
- [Vesta](https://github.com/vesta-finance/vesta-protocol-v1/releases/tag/v1.0) is multi-collateral. Each position can have only one collateral type and it is linked to a specific stability pool. Trinity is a fork of Vesta v1.0. 
- [Yeti](https://techdocs.yeti.finance/about-yeti-finance/contracts) allows cross-collateral positions, linked to a single stability pool

Trinity's debt token is called TRI.

Trinity has an unique multi-collateral design in which each position has a single collateral type, but they are all linked to the same stability pool:

![Trinity's multi-collateral design](images/multi-collateral.png)

***
## Core System Architecture

The core Liquity system consists of several smart contracts, which are deployable to the Ethereum blockchain.

All application logic and data are contained in these contracts - there is no need for a separate database or back end logic running on a web server. In effect, the Ethereum network is itself the Trinity back end. As such, all balances and contract data are public.

The three main contracts - `BorrowerOperations.sol`, `VesselManager.sol` and `StabilityPool.sol` - hold the user-facing public functions, and contain most of the internal system logic. Together they control Vessel state updates and movements of collateral and debt tokens around the system.

`AdminContract.sol` holds all the admin related functions, like adding a new collateral or modifying its parameters. Such governance - compared to Liquity's fully decentralized model - is needed as the LSD ecosystem is still changing.

### Core Smart Contracts

`AdminContract.sol` - contains all the functions to create a new collateral or modify its parameters. It is called by the other contracts to check if a collateral is valid and what are their parameters.

`BorrowerOperations.sol` - contains the basic operations by which borrowers interact with their Vessel: Vessel creation, collateral top-up / withdrawal, debt token issuance and repayment. BorrowerOperations functions call in to VesselManager, telling it to update Vessel state, where necessary. BorrowerOperations functions also call in to the various Pools, telling them to move tokens between Pools or between Pool <> user, where necessary.

`VesselManager.sol` and `VesselManagerOperations.sol` - contain functionality for liquidations and redemptions. Also contain the state of each Vessel - i.e. a record of the Vessel’s collateral and debt. VesselManager does not hold value (i.e. tokens). VesselManager functions call in to the various Pools to tell them to move tokens between Pools, where necessary.

`TrinityBase.sol` - Both VesselManager and BorrowerOperations inherit from this parent contract, which contains some common functions.

`StabilityPool.sol` - contains functionality for Stability Pool operations: making deposits, and withdrawing compounded deposits and accumulated collateral. Holds the debt token Stability Pool deposits, and the collateral gains for depositors, from liquidations.

`DebtToken.sol` - the debt token contract, which implements the ERC20 fungible token standard in conjunction with EIP-2612 and a mechanism that blocks (accidental) transfers to addresses like the StabilityPool and address(0) that are not supposed to receive funds through direct transfers. The contract mints, burns and transfers tokens.

`SortedVessels.sol` - a doubly linked list that stores addresses of Vessel owners, sorted by their individual collateralization ratio (ICR). It inserts and re-inserts Vessels at the correct position, based on their ICR.

`PriceFeed.sol` - Contains functionality for obtaining the current collateral:USD price, which the system uses for calculating collateralization ratios.

### Data and Value Silo Contracts

Along with `StabilityPool.sol`, these contracts hold collateral and/or tokens for their respective parts of the system, and contain minimal logic:

`ActivePool.sol` - holds the total balance for each collateral and records the total debt of the active Vessels.

`DefaultPool.sol` - holds the total balance for each collateral and records the total debt of the liquidated Vessels that are pending redistribution to active Vessels. If a Vessel has pending collateral/debt “rewards” in the DefaultPool, then they will be applied to the Vessel when it next undergoes a borrower operation, a redemption, or a liquidation.

`CollSurplusPool.sol` - holds the collateral surplus from Vessels that have been fully redeemed from as well as from Vessels with an ICR > MCR that were liquidated in Recovery Mode. Sends the surplus back to the owning borrower, when told to do so by `BorrowerOperations.sol`.

`GasPool.sol` - holds the total debt token liquidation reserves. Debt tokens are moved into the `GasPool` when a Vessel is opened, and moved out when a Vessel is liquidated or closed.

## Smart Contract changes from Vesta

The general changes in the design are the following:
- Single Stability Pool (StabilityPoolManager was removed)
- No pure ETH allowed in the system, only ERC20 tokens
- Each collateral has an individual mintcap
- Added timelock for system changes
- Removed checkContract() as the addresses will be set on deployment. Some will still be upgradable.
- Redemptions are 0.97 to 1 (the redeemer pays a 3% fee to the borrower)
- Troves are named Vessels instead

`ActivePool` - no major changes

`AdminContract` - major rewrite (removed VestaParameters, the collaterals are added and managed from there)

`BorrowerOperations` - major refactoring

`CollSurplusPool` - no major changes

`DebtToken` - added whitelisted burn and mint.

`DefaultPool` - no major changes

`GasPool` - no changes

`TrinityBase` - no changes

`TrinityMath` - no changes

`PriceFeed` - major rewrite to add and update the price feed of all collateral types

`SortedVessels` - no changes

`StabilityPool` - heavy refactoring to have only one StabilityPool linked to all the sorted troves

`Timelock` - new contract

`VesselManager` - heavy refactoring

`VesselManagerOperations` - heavy refactoring. HintHelpers was added here

***

## Development

Trinity is based on Yarn's [workspaces](https://classic.yarnpkg.com/en/docs/workspaces/) feature. You might be able to install some of the packages individually with npm, but to make all interdependent packages see each other, you'll need to use Yarn.

### Clone & Install

```
git clone https://github.com/Gravity-Finance/Gravity-protocol.git Trinity
cd Trinity
yarn
```

### Deploy to a local node
Add the `secret.js` file based on `secret.js.template` in case you don't have it set already.

Run:
```
yarn hardhat node
```

and on a second terminal:
```
yarn deploy-local
```

***

## Running Tests

### Hardhat

```
# install dependencies
yarn install

# copy secrets file
cp secrets.env.template secrets.env

# edit secrets.env (only GOERLI_DEPLOYER_PRIVATEKEY is required)

# run tests 
yarn test 

```

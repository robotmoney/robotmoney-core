// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 check 2 (feed health, sequencer, USDC peg), §5.9.5
//            (maxFeedAge, sequencerGrace, usdcPegBandBps); docs/technical/one-vault-timed-flows-eng-plan.md E16, E19
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {FeedStatus, BPS} from "../FundTypes.sol";

/// @title FeedLib
/// @notice Chainlink reads for the outside-feed layer (layer 2 of proposal §5.9.1). Used by the FlowQueue (check 2,
///         check 4, check 6, the bound prices and the quotes) and by the fund's NAV views (E19).
///
///         Every read is a raw `staticcall` with a length check, so a feed address with no code, a reverting feed
///         or one that returns short data gives `ReadFailed` instead of reverting the caller. A failed read never
///         yields a price: the price is 0 unless the status is Ok.
///
///         The functions are `internal` (inlined). The fund may want them `public` (linked) for size; that changes
///         no call site (INTERFACES.md §5).
library FeedLib {
    /// @dev Every price this library returns is USD with 8 decimals, whatever the feed's own `decimals()`.
    uint8 internal constant PRICE_DECIMALS = 8;

    /// @dev 1.00000000 in 8 decimals: the USDC peg.
    uint256 internal constant ONE_USD = 1e8;

    /// @dev `decimals()` above this is treated as malformed (`ReadFailed`): no Chainlink feed uses more than 18.
    uint8 private constant MAX_FEED_DECIMALS = 36;

    /// @notice Read `feed` (an `IChainlinkAggregator`). `status` is Ok only if the call succeeded, `answer > 0`,
    ///         the round is complete (`updatedAt != 0`, `answeredInRound >= roundId`) and
    ///         `block.timestamp - updatedAt <= maxAge`. Never reverts: a reverting or code-less feed returns
    ///         `ReadFailed`, and address(0) returns `NoFeed`. An `updatedAt` in the future is `ReadFailed`.
    /// @return status Why the read is not usable, or Ok.
    /// @return price8 The answer scaled to 8 decimals, rounded DOWN (0 unless Ok). An answer that scales to 0 is
    ///                `NonPositive`.
    function read(address feed, uint32 maxAge) internal view returns (FeedStatus status, uint256 price8) {
        if (feed == address(0)) return (FeedStatus.NoFeed, 0);
        (bool ok, uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = _latest(feed);
        if (!ok) return (FeedStatus.ReadFailed, 0);
        (bool decOk, uint8 dec) = _decimals(feed);
        if (!decOk) return (FeedStatus.ReadFailed, 0);
        if (answer <= 0) return (FeedStatus.NonPositive, 0);
        if (updatedAt == 0 || answeredInRound < roundId) return (FeedStatus.RoundIncomplete, 0);
        if (updatedAt > block.timestamp) return (FeedStatus.ReadFailed, 0);
        if (block.timestamp - updatedAt > maxAge) return (FeedStatus.Stale, 0);
        uint256 a = uint256(answer);
        if (dec > PRICE_DECIMALS) price8 = a / (10 ** (dec - PRICE_DECIMALS));
        else price8 = a * (10 ** (PRICE_DECIMALS - dec));
        if (price8 == 0) return (FeedStatus.NonPositive, 0);
        return (FeedStatus.Ok, price8);
    }

    /// @notice The Base L2 sequencer uptime feed (answer 0 = up, anything else = down; `startedAt` = when that
    ///         status began). `ok` only if it reports up and has been up for at least `grace` seconds. Never reverts.
    ///         `startedAt == 0` (no valid round) is `RoundIncomplete`; a `startedAt` in the future counts as inside
    ///         the grace period.
    /// @return ok     True when the sequencer is up and has been for `grace`.
    /// @return status Ok, SequencerDown, SequencerGrace, RoundIncomplete, ReadFailed or NoFeed.
    function sequencerUp(address feed, uint32 grace) internal view returns (bool ok, FeedStatus status) {
        if (feed == address(0)) return (false, FeedStatus.NoFeed);
        (bool callOk,, int256 answer, uint256 startedAt,,) = _latest(feed);
        if (!callOk) return (false, FeedStatus.ReadFailed);
        if (answer != 0) return (false, FeedStatus.SequencerDown);
        if (startedAt == 0) return (false, FeedStatus.RoundIncomplete);
        if (startedAt > block.timestamp || block.timestamp - startedAt < grace) {
            return (false, FeedStatus.SequencerGrace);
        }
        return (true, FeedStatus.Ok);
    }

    /// @notice The USDC / USD feed: `ok` when `read` is Ok and the price is within `bandBps` of 1.00000000
    ///         (`|price − 1e8| × 10 000 ≤ bandBps × 1e8`, the edge counts as inside). Never reverts.
    /// @return ok     True when USDC is inside the band.
    /// @return status Ok, OffPeg, or the `read` failure.
    /// @return price8 USDC in USD with 8 decimals, for converting a USD feed price into USDC (0 unless read Ok;
    ///                returned also when OffPeg, so a caller can report it).
    function usdcPeg(address feed, uint32 maxAge, uint16 bandBps)
        internal
        view
        returns (bool ok, FeedStatus status, uint256 price8)
    {
        (status, price8) = read(feed, maxAge);
        if (status != FeedStatus.Ok) return (false, status, 0);
        uint256 diff = price8 > ONE_USD ? price8 - ONE_USD : ONE_USD - price8;
        if (diff * BPS > uint256(bandBps) * ONE_USD) return (false, FeedStatus.OffPeg, price8);
        return (true, FeedStatus.Ok, price8);
    }

    // ─── Raw reads ───────────────────────────────────────────────────────────

    /// @dev `latestRoundData()` by staticcall. `ok` is false for a code-less address, a revert or short data.
    function _latest(address feed)
        private
        view
        returns (bool ok, uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (feed.code.length == 0) return (false, 0, 0, 0, 0, 0);
        (bool success, bytes memory ret) = feed.staticcall(abi.encodeWithSignature("latestRoundData()"));
        if (!success || ret.length < 160) return (false, 0, 0, 0, 0, 0);
        uint256 r;
        uint256 a;
        uint256 air;
        assembly {
            r := mload(add(ret, 32))
            a := mload(add(ret, 64))
            startedAt := mload(add(ret, 96))
            updatedAt := mload(add(ret, 128))
            air := mload(add(ret, 160))
        }
        // Words that do not fit their declared type are malformed data, not a price.
        if (r > type(uint80).max || air > type(uint80).max) return (false, 0, 0, 0, 0, 0);
        return (true, uint80(r), int256(a), startedAt, updatedAt, uint80(air));
    }

    /// @dev `decimals()` by staticcall; `ok` false on a revert, short data or a value above MAX_FEED_DECIMALS.
    function _decimals(address feed) private view returns (bool ok, uint8 dec) {
        (bool success, bytes memory ret) = feed.staticcall(abi.encodeWithSignature("decimals()"));
        if (!success || ret.length < 32) return (false, 0);
        uint256 d = abi.decode(ret, (uint256));
        if (d > MAX_FEED_DECIMALS) return (false, 0);
        return (true, uint8(d));
    }
}

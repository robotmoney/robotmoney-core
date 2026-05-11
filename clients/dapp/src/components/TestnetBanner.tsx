/**
 * TestnetBanner — permanent top-of-app banner declaring that the dapp
 * is pointed at the RobotMoney testnet (a historical Base snapshot).
 *
 * Snapshot metadata is read from build-time env:
 *   - VITE_FORK_BLOCK_TIMESTAMP — ISO 8601 timestamp of the forked block
 *   - VITE_FORK_BLOCK_NUMBER    — Base block number used as the fork origin
 *
 * Both are optional; the banner degrades gracefully when either is
 * missing.
 */
interface Props {
  envClass: "fork" | "devnet" | "testnet" | "mainnet";
  forkTimestamp?: string;
  forkBlock?: string;
}

export function TestnetBanner({ envClass, forkTimestamp, forkBlock }: Props) {
  if (envClass === "mainnet") return null;

  const date = forkTimestamp ? formatTimestamp(forkTimestamp) : null;

  return (
    <div className="testnet-banner" data-testid="testnet-banner" role="note">
      <span className="testnet-banner-tag">RobotMoney testnet</span>
      <span className="testnet-banner-body">
        Base network snapshot
        {date && (
          <>
            {" from "}
            <strong>{date}</strong>
          </>
        )}
        {forkBlock && (
          <>
            {" · block "}
            <code>{forkBlock}</code>
          </>
        )}
        . No real funds at risk.
      </span>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/**
 * Shared vault UI component library — barrel export.
 *
 * All three components are consumed by both the deposit/withdraw page
 * (AgentsPanel → AdminFlow → DepositWithdrawTab) and the portfolio
 * explorer (AccountLayerView → PortfolioPosition / AccountLayerView).
 *
 * docs/architecture.md §5.3 — shared vault UI library.
 */
export { VaultPositionCard } from "./VaultPositionCard";
export type { VaultPositionCardProps } from "./VaultPositionCard";

export { ProportionPreview } from "./ProportionPreview";
export type { ProportionPreviewProps } from "./ProportionPreview";

export { ReceiptValueDisplay } from "./ReceiptValueDisplay";
export type { ReceiptValueDisplayProps } from "./ReceiptValueDisplay";

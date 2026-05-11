import type { Dispatch, SetStateAction } from "react";

type Props = Readonly<{
  validUntil: string;
  setValidUntil: Dispatch<SetStateAction<string>>;
  maxPerPayment: string;
  setMaxPerPayment: Dispatch<SetStateAction<string>>;
  maxPerWindow: string;
  setMaxPerWindow: Dispatch<SetStateAction<string>>;
  shareReceiver: string;
  setShareReceiver: Dispatch<SetStateAction<string>>;
  testIdPrefix?: string;
}>;

export function PolicyFields(props: Props) {
  const p = props.testIdPrefix ?? "";
  return (
    <>
      <label>
        Valid-until (unix seconds)
        <input
          data-testid={`${p}validUntil-input`}
          value={props.validUntil}
          onChange={(e) => props.setValidUntil(e.target.value)}
        />
      </label>
      <label>
        Max per payment (USDC base units)
        <input
          data-testid={`${p}maxPerPayment-input`}
          value={props.maxPerPayment}
          onChange={(e) => props.setMaxPerPayment(e.target.value)}
        />
      </label>
      <label>
        Max per window (USDC base units)
        <input
          data-testid={`${p}maxPerWindow-input`}
          value={props.maxPerWindow}
          onChange={(e) => props.setMaxPerWindow(e.target.value)}
        />
      </label>
      <label>
        Share receiver
        <input
          data-testid={`${p}shareReceiver-input`}
          value={props.shareReceiver}
          onChange={(e) => props.setShareReceiver(e.target.value)}
          placeholder="0x..."
        />
      </label>
    </>
  );
}

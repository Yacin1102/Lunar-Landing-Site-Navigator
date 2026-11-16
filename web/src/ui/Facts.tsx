import type { ReactNode } from "react";

/** One labelled value. The value must already carry its unit. */
export interface Fact {
  label: string;
  value: ReactNode;
}

/** A plain list of labelled values, used for every readout in the side panel. */
export function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="facts">
      {facts.map((fact) => (
        <div key={fact.label} className="fact">
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

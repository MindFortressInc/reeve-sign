import type { SVGAttributes } from 'react';

export type LogoProps = SVGAttributes<SVGSVGElement>;

// Reeve.Sign wordmark. Rendered with `currentColor` so it inherits the surrounding
// text color and themes correctly in light/dark + the PDF certificate/audit-log views.
export const BrandingLogo = ({ ...props }: LogoProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 160"
      fill="none"
      role="img"
      aria-label="Reeve.Sign"
      {...props}
    >
      <text
        x="0"
        y="120"
        fill="currentColor"
        fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        fontSize="128"
        fontWeight="700"
        letterSpacing="-4"
        textLength="700"
        lengthAdjust="spacingAndGlyphs"
      >
        Reeve
        <tspan fontWeight="500">.Sign</tspan>
      </text>
    </svg>
  );
};

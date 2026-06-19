import type { SVGAttributes } from 'react';

export type LogoProps = SVGAttributes<SVGSVGElement>;

// Reeve.Sign compact mark ("R" + dot accent). Uses `currentColor` so it themes
// with the surrounding text color (matches the wordmark in branding-logo.tsx).
export const BrandingLogoIcon = ({ ...props }: LogoProps) => {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 84" fill="none" role="img" aria-label="Reeve.Sign" {...props}>
      <text
        x="38"
        y="62"
        textAnchor="middle"
        fill="currentColor"
        fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        fontSize="64"
        fontWeight="700"
      >
        R
      </text>
      <circle cx="70" cy="58" r="7" fill="currentColor" />
    </svg>
  );
};

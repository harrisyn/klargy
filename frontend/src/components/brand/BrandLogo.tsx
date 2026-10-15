import React from 'react';
import { APP_NAME } from '@/lib/appConfig';
import { DEFAULT_APP_NAME } from '@/lib/runtimeConfig';

// The product's own logo files (public/brand). The lockup and wordmark spell
// "klargy", so they are only used while the app runs under that name; a
// deployment with its own APP_NAME gets the mark next to its name as text.
const BRAND = '/brand';
const LOCKUP_RATIO = 4.35; // width / height of klargy-logo.svg

export function isDefaultBrand(name: string = APP_NAME): boolean {
  return name.trim().toLowerCase() === DEFAULT_APP_NAME.toLowerCase();
}

/** The crescent-and-stars mark on its own (square). */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`${BRAND}/klargy-mark.svg`} width={size} height={size} alt="" aria-hidden="true" className={className} />
  );
}

interface BrandLogoProps {
  /** Rendered height of the logo in px; the width follows the artwork. */
  height?: number;
  /** "dark" for ink backgrounds (sidebar, auth panel), "light" for paper. */
  surface?: 'light' | 'dark';
  /** Show only the mark below this viewport width (px). */
  compactBelow?: 480 | 900;
  className?: string;
}

/**
 * Mark + wordmark lockup. It scales with `height` (SVG, so it stays sharp)
 * and, with `compactBelow`, collapses to the mark on narrow screens via CSS
 * (no layout shift, no JS). The app's name is always in the accessible text.
 */
export function BrandLogo({ height = 32, surface = 'light', compactBelow, className }: BrandLogoProps) {
  const compact = compactBelow ? ` brand-logo-compact-${compactBelow}` : '';
  const style = { ['--brand-h' as string]: `${height}px` } as React.CSSProperties;
  if (!isDefaultBrand()) {
    return (
      <span className={`brand-logo brand-logo-named${className ? ` ${className}` : ''}`} style={style}>
        <BrandMark size={height} className="brand-logo-mark-only" />
        <span className="brand-logo-name">{APP_NAME}</span>
      </span>
    );
  }
  const lockup = surface === 'dark' ? 'klargy-logo-light.svg' : 'klargy-logo.svg';
  return (
    <span className={`brand-logo${compact}${className ? ` ${className}` : ''}`} style={style}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${BRAND}/${lockup}`}
        alt=""
        width={Math.round(height * LOCKUP_RATIO)}
        height={height}
        className="brand-logo-full"
      />
      {compactBelow && <BrandMark size={height} className="brand-logo-mark" />}
      <span className="sr-only">{APP_NAME}</span>
    </span>
  );
}

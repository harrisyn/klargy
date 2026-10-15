'use client';

import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** A QR code drawn locally as SVG: no third-party service sees the link. */
export default function QrCode({ value, size = 160, className, label }: { value: string; size?: number; className?: string; label?: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0d2a47', light: '#ffffff' } })
      .then((s) => { if (!cancelled) setSvg(s); })
      .catch(() => setSvg(''));
    return () => { cancelled = true; };
  }, [value]);
  return (
    <span
      className={className}
      role="img"
      aria-label={label || `QR code for ${value}`}
      style={{ display: 'inline-block', width: size, height: size, lineHeight: 0 }}
      // qrcode's own SVG output; the value is only ever encoded, not injected.
      dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg width="100%" height="100%" ') }}
    />
  );
}

/** PNG data URL for downloads. */
export function qrPng(value: string, size = 1024) {
  return QRCode.toDataURL(value, { width: size, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0d2a47', light: '#ffffff' } });
}

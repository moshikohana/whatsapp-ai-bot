import React from 'react';
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate, spring } from 'remotion';

export const QuoteVideo = ({ quote, author, bgColor, accentColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const quoteOpacity = interpolate(frame, [10, 40], [0, 1], { extrapolateRight: 'clamp' });
  const quoteScale = spring({ frame, fps, from: 0.9, to: 1, durationInFrames: 35 });
  const authorOpacity = interpolate(frame, [40, 60], [0, 1], { extrapolateRight: 'clamp' });
  const markOpacity = interpolate(frame, [0, 15], [0, 0.15], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(frame, [150, 180], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, direction: 'rtl', opacity: fadeOut }}>
      {/* Decorative background quote mark */}
      <div style={{
        position: 'absolute', top: '15%', right: '10%',
        fontSize: 400, fontFamily: 'Georgia, serif',
        color: accentColor, opacity: markOpacity,
        lineHeight: 1,
      }}>
        &ldquo;
      </div>

      {/* Quote content */}
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: 'center', height: '100%', padding: '80px',
        textAlign: 'center', zIndex: 1,
      }}>
        <p style={{
          fontFamily: 'Georgia, Arial, sans-serif', fontSize: 52, fontWeight: 400,
          color: '#ffffff', lineHeight: 1.6, maxWidth: '85%',
          opacity: quoteOpacity, transform: `scale(${quoteScale})`,
          fontStyle: 'italic',
        }}>
          &ldquo;{quote}&rdquo;
        </p>

        {/* Divider */}
        <div style={{
          width: 100, height: 3, backgroundColor: accentColor,
          margin: '40px 0', opacity: authorOpacity,
        }} />

        {/* Author */}
        <p style={{
          fontFamily: 'Arial, sans-serif', fontSize: 34,
          color: accentColor, opacity: authorOpacity,
          fontWeight: 600,
        }}>
          {author}
        </p>
      </div>
    </AbsoluteFill>
  );
};

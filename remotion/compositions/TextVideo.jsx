import React from 'react';
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate, spring } from 'remotion';

export const TextVideo = ({ title, subtitle, body, bgColor, textColor, accentColor }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Animations
  const titleY = spring({ frame, fps, from: -80, to: 0, durationInFrames: 30 });
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  const subtitleOpacity = interpolate(frame, [15, 35], [0, 1], { extrapolateRight: 'clamp' });
  const bodyOpacity = interpolate(frame, [30, 50], [0, 1], { extrapolateRight: 'clamp' });

  // Accent bar animation
  const barWidth = spring({ frame, fps, from: 0, to: 300, durationInFrames: 40 });

  // Fade out at end
  const fadeOut = interpolate(frame, [120, 150], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, direction: 'rtl', opacity: fadeOut }}>
      {/* Background gradient overlay */}
      <div style={{
        position: 'absolute', width: '100%', height: '100%',
        background: `radial-gradient(circle at 50% 30%, ${accentColor}22 0%, transparent 60%)`,
      }} />

      {/* Content */}
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: 'center', height: '100%', padding: '80px 60px',
        textAlign: 'center',
      }}>
        {/* Accent bar */}
        <div style={{
          width: barWidth, height: 4, backgroundColor: accentColor,
          marginBottom: 40, borderRadius: 2,
        }} />

        {/* Title */}
        <h1 style={{
          fontFamily: 'Arial, sans-serif', fontSize: 72, fontWeight: 'bold',
          color: textColor, margin: 0, lineHeight: 1.2,
          transform: `translateY(${titleY}px)`, opacity: titleOpacity,
        }}>
          {title}
        </h1>

        {/* Subtitle */}
        {subtitle && (
          <h2 style={{
            fontFamily: 'Arial, sans-serif', fontSize: 42, fontWeight: 300,
            color: accentColor, margin: '20px 0 0', opacity: subtitleOpacity,
          }}>
            {subtitle}
          </h2>
        )}

        {/* Body */}
        {body && (
          <p style={{
            fontFamily: 'Arial, sans-serif', fontSize: 32, color: textColor,
            opacity: bodyOpacity * 0.85, marginTop: 40, lineHeight: 1.6,
            maxWidth: '90%',
          }}>
            {body}
          </p>
        )}

        {/* Accent bar bottom */}
        <div style={{
          width: barWidth * 0.6, height: 4, backgroundColor: accentColor,
          marginTop: 40, borderRadius: 2, opacity: 0.5,
        }} />
      </div>
    </AbsoluteFill>
  );
};

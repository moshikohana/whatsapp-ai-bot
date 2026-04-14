import React from 'react';
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate } from 'remotion';

export const SlideshowVideo = ({ slides, bgColor, accentColor }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const framesPerSlide = Math.floor(durationInFrames / slides.length);

  const currentSlideIndex = Math.min(
    Math.floor(frame / framesPerSlide),
    slides.length - 1
  );
  const slideFrame = frame - currentSlideIndex * framesPerSlide;

  const slide = slides[currentSlideIndex];

  // Slide animations
  const fadeIn = interpolate(slideFrame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const fadeOut = interpolate(slideFrame, [framesPerSlide - 15, framesPerSlide], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const opacity = Math.min(fadeIn, fadeOut);
  const slideY = interpolate(slideFrame, [0, 15], [30, 0], { extrapolateRight: 'clamp' });

  // Progress bar
  const progress = (frame / durationInFrames) * 100;

  // Slide counter
  const counter = `${currentSlideIndex + 1}/${slides.length}`;

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, direction: 'rtl' }}>
      {/* Progress bar at top */}
      <div style={{
        position: 'absolute', top: 0, right: 0, height: 4,
        width: `${progress}%`, backgroundColor: accentColor,
        transition: 'width 0.1s',
      }} />

      {/* Slide counter */}
      <div style={{
        position: 'absolute', top: 40, left: 40,
        fontFamily: 'Arial, sans-serif', fontSize: 24,
        color: accentColor, opacity: 0.7,
      }}>
        {counter}
      </div>

      {/* Slide content */}
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: 'center', height: '100%', padding: '100px 60px',
        textAlign: 'center', opacity,
        transform: `translateY(${slideY}px)`,
      }}>
        {/* Slide title */}
        <h1 style={{
          fontFamily: 'Arial, sans-serif', fontSize: 64, fontWeight: 'bold',
          color: '#ffffff', margin: 0, lineHeight: 1.3,
        }}>
          {slide.title}
        </h1>

        {/* Divider */}
        <div style={{
          width: 150, height: 3, backgroundColor: accentColor,
          margin: '30px 0', borderRadius: 2,
        }} />

        {/* Slide text */}
        {slide.text && (
          <p style={{
            fontFamily: 'Arial, sans-serif', fontSize: 36,
            color: '#ffffff', opacity: 0.85, lineHeight: 1.6,
            maxWidth: '85%',
          }}>
            {slide.text}
          </p>
        )}
      </div>
    </AbsoluteFill>
  );
};

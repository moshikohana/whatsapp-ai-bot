import React from 'react';
import { Composition } from 'remotion';
import { TextVideo } from './compositions/TextVideo';
import { SlideshowVideo } from './compositions/SlideshowVideo';
import { QuoteVideo } from './compositions/QuoteVideo';

export const Root = () => {
  return (
    <>
      {/* Text/Title video — great for news, announcements */}
      <Composition
        id="TextVideo"
        component={TextVideo}
        durationInFrames={150}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          title: 'כותרת',
          subtitle: 'תת כותרת',
          body: '',
          bgColor: '#1a1a2e',
          textColor: '#ffffff',
          accentColor: '#e94560',
        }}
      />

      {/* Quote video — for sharing quotes/text */}
      <Composition
        id="QuoteVideo"
        component={QuoteVideo}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          quote: 'הציטוט כאן',
          author: 'מחבר',
          bgColor: '#0f0f23',
          accentColor: '#ffdd57',
        }}
      />

      {/* Slideshow — multiple text slides */}
      <Composition
        id="SlideshowVideo"
        component={SlideshowVideo}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          slides: [
            { title: 'שקף 1', text: 'תוכן' },
            { title: 'שקף 2', text: 'תוכן' },
          ],
          bgColor: '#16213e',
          accentColor: '#00b4d8',
        }}
      />
    </>
  );
};

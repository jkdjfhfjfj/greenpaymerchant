import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;

export function Scene4() {
  const [featuresReady, setFeaturesReady] = useState(false);
  const [copyReady, setCopyReady] = useState(false);
  const [closing, setClosing] = useState(false);
  useSceneTimer([
    { time: 550, callback: () => setFeaturesReady(true) },
    { time: 1150, callback: () => setCopyReady(true) },
    { time: 2850, callback: () => setClosing(true) },
  ]);

  return (
    <motion.section
      className="film-scene finale-scene"
      initial={{ clipPath: 'circle(0% at 50% 49%)', scale: 1.06, opacity: 0.84 }}
      animate={{ clipPath: 'circle(150% at 50% 49%)', scale: 1, opacity: 1 }}
      exit={{ clipPath: 'circle(0% at 50% 49%)', scale: 1.1, opacity: 0 }}
      transition={{ duration: 0.54, ease: EASE }}
    >
      <div className="finale-grain" aria-hidden="true" />
      <motion.div
        className="finale-feature-line"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: featuresReady ? 1 : 0, y: featuresReady ? 0 : 12 }}
        transition={{ duration: 0.36, ease: EASE }}
      >
        INVOICES <i /> PAYMENT LINKS <i /> DEVELOPER API
      </motion.div>

      <div className="finale-lockup">
        <AnimatePresence mode="sync" initial={false}>
          <motion.div
            className="finale-brand"
            key="greenpay-brand"
            initial={{ opacity: 0, scale: 0.72, y: 18, filter: 'blur(7px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ type: 'spring', stiffness: 230, damping: 22 }}
          >
            <img
              src={`${import.meta.env.BASE_URL}images/greenpay-mark.svg`}
              alt=""
              className="finale-logo"
            />
            <span>Greenpay</span>
          </motion.div>
        </AnimatePresence>

        <motion.p
          className="finale-url"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: copyReady ? 1 : 0, y: copyReady ? 0 : 14 }}
          transition={{ duration: 0.38, delay: 0.22, ease: EASE }}
        >
          greenpay.co.ke
        </motion.p>

        <motion.div
          className="finale-market-note"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: copyReady ? 1 : 0, y: copyReady ? 0 : 16 }}
          transition={{ duration: 0.34, delay: 0.2, ease: EASE }}
        >
          <strong>20 African collection markets + global USD</strong>
          <span>M-Pesa in Kenya · Cards where available</span>
          <small>Card and collection options vary by currency and merchant verification.</small>
        </motion.div>
      </div>

      <motion.div
        className="finale-loop-ring"
        initial={{ scale: 0.64, opacity: 0 }}
        animate={{
          scale: closing ? 24 : 0.64,
          opacity: closing ? 0.52 : 0,
          borderWidth: closing ? '0.02vmin' : '0.38vmin',
        }}
        transition={{ duration: closing ? 0.42 : 0.8, delay: closing ? 0 : 0.22, ease: EASE }}
        aria-hidden="true"
      />
    </motion.section>
  );
}
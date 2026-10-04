import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;

export function Scene4() {
  const [ready, setReady] = useState(false);
  useSceneTimer([{ time: 380, callback: () => setReady(true) }]);

  return (
    <motion.section
      className="film-scene scene-close"
      initial={{ clipPath: 'circle(38% at 50% 49%)', scale: 1.04, opacity: 0.85 }}
      animate={{ clipPath: 'circle(150% at 50% 49%)', scale: 1, opacity: 1 }}
      exit={{ clipPath: 'circle(150% at 50% 49%)', scale: 1, opacity: 1 }}
      transition={{ duration: 0.55, ease: EASE }}
    >
      <div className="close-route" aria-hidden="true">
        <motion.div
          className="close-ring"
          initial={{ scale: 0.58, rotate: -28, opacity: 0.58 }}
          animate={{ scale: ready ? 1 : 0.74, rotate: ready ? 0 : -14, opacity: 1 }}
          transition={{ duration: 0.95, ease: EASE }}
        />
        <motion.span
          className="close-route-line"
          initial={{ scaleX: 0, transformOrigin: 'center' }}
          animate={{ scaleX: ready ? 1 : 0.5 }}
          transition={{ duration: 0.8, delay: 0.18, ease: EASE }}
        />
      </div>

      <div className="close-topline">PAYMENT LINKS <i /> DEVELOPER API <i /> CLEAR RECORDS</div>

      <div className="close-lockup">
        <AnimatePresence mode="sync" initial={false}>
          {ready && (
            <motion.div
              className="close-brand"
              key="greenpay-brand"
              initial={{ opacity: 0, scale: 0.72, y: 22, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ type: 'spring', stiffness: 230, damping: 22 }}
            >
              <img
                src={`${import.meta.env.BASE_URL}images/greenpay-mark.svg`}
                alt=""
                className="close-logo"
              />
              <span>Greenpay</span>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.p
          className="close-url"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: ready ? 1 : 0, scale: ready ? 1 : 0.8 }}
          transition={{ duration: 0.42, delay: 0.24, ease: EASE }}
        >
          greenpay.co.ke
        </motion.p>

        <motion.div
          className="close-market-note"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: ready ? 1 : 0, y: ready ? 0 : 18 }}
          transition={{ duration: 0.38, delay: 0.38, ease: EASE }}
        >
          <strong>25 African markets in the catalog + global USD</strong>
          <span>Collection availability varies by currency and merchant verification.</span>
        </motion.div>
      </div>

      <motion.div
        className="close-loop-ring"
        initial={{ scale: 0.78, opacity: 0 }}
        animate={{ scale: ready ? 1 : 0.78, opacity: ready ? 0.92 : 0 }}
        transition={{ duration: 0.8, delay: 0.3, ease: EASE }}
        aria-hidden="true"
      />
    </motion.section>
  );
}
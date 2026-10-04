import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, Link2 } from 'lucide-react';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;

export function Scene2() {
  const [beat, setBeat] = useState(0);
  useSceneTimer([
    { time: 850, callback: () => setBeat(1) },
    { time: 1750, callback: () => setBeat(2) },
    { time: 2600, callback: () => setBeat(3) },
  ]);

  return (
    <motion.section
      className="film-scene scene-links"
      initial={{ clipPath: 'circle(72% at 51% 51%)', scale: 1.08, opacity: 0.82 }}
      animate={{ clipPath: 'circle(150% at 51% 51%)', scale: 1, opacity: 1 }}
      exit={{ clipPath: 'inset(0 0 100% 0)', scale: 1.14, rotateX: 12, opacity: 0 }}
      transition={{ duration: 0.48, ease: EASE }}
    >
      <div className="links-topline">
        <span>01 / PAYMENT LINKS</span>
        <span className="links-topline-mark"><Link2 size={17} /></span>
      </div>

      <div className="links-copy">
        <motion.p
          initial={{ opacity: 0, x: -25 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.45, ease: EASE, delay: 0.12 }}
        >
          MAKE A LINK.
        </motion.p>
        <AnimatePresence mode="sync" initial={false}>
          {beat >= 2 && (
            <motion.p
              key="share"
              className="links-share"
              initial={{ opacity: 0, x: 45, skewX: -8 }}
              animate={{ opacity: 1, x: 0, skewX: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.42, ease: EASE }}
            >
              SHARE IT.
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <motion.div
        className="payment-link-card"
        initial={{ y: 90, rotate: -6, scale: 0.82, opacity: 0 }}
        animate={{ y: 0, rotate: -1.5, scale: 1, opacity: 1 }}
        exit={{ scale: 1.8, rotate: 8, opacity: 0, filter: 'blur(9px)' }}
        transition={{ type: 'spring', stiffness: 210, damping: 24, delay: 0.16 }}
      >
        <div className="link-card-label"><span>PAYMENT LINK</span><i /></div>
        <div className="link-card-title">A checkout<br /><em>that travels.</em></div>
        <div className="link-card-url">
          <span>greenpay.co.ke/pay/…</span>
          <ArrowUpRight size={18} />
        </div>
        <motion.div
          className="link-card-route"
          initial={{ scaleX: 0, transformOrigin: 'left' }}
          animate={{ scaleX: beat >= 1 ? 1 : 0.28 }}
          transition={{ duration: 0.7, ease: EASE }}
        />
      </motion.div>

      <div className="link-share-marks" aria-hidden="true">
        {[0, 1, 2].map((item) => (
          <motion.i
            key={item}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: beat >= 2 ? 1 : 0, opacity: beat >= 2 ? 1 : 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 19, delay: item * 0.13 }}
          />
        ))}
      </div>

      <motion.div
        className="links-footnote"
        initial={{ opacity: 0, y: 22 }}
        animate={{ opacity: beat >= 3 ? 1 : 0, y: beat >= 3 ? 0 : 22 }}
        transition={{ duration: 0.35, ease: EASE }}
      >
        Customers choose an option available for their currency.
      </motion.div>

      <motion.div
        className="links-gold-ring"
        initial={{ scale: 0.72, rotate: -10, opacity: 0.62 }}
        animate={{ scale: beat >= 3 ? 1.13 : 0.96, rotate: 22, opacity: 0.9 }}
        transition={{ duration: 1.4, ease: EASE }}
        aria-hidden="true"
      />
    </motion.section>
  );
}
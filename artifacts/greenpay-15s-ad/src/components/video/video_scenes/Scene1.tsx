import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;

export function Scene1() {
  const [beat, setBeat] = useState(0);
  useSceneTimer([
    { time: 650, callback: () => setBeat(1) },
    { time: 1350, callback: () => setBeat(2) },
    { time: 2400, callback: () => setBeat(3) },
  ]);

  return (
    <motion.section
      className="film-scene scene-scope"
      initial={{ clipPath: 'circle(96% at 50% 52%)', scale: 1.03, opacity: 0.82 }}
      animate={{ clipPath: 'circle(150% at 50% 52%)', scale: 1, opacity: 1 }}
      exit={{ clipPath: 'circle(0% at 52% 52%)', scale: 1.3, rotate: 3, opacity: 0 }}
      transition={{ duration: 0.48, ease: EASE }}
    >
      <div className="scope-grain" aria-hidden="true" />
      <motion.div
        className="scope-orbit"
        initial={{ scale: 0.62, rotate: -18 }}
        animate={{ scale: beat >= 2 ? 1.08 : 0.92, rotate: beat >= 2 ? 16 : 0 }}
        transition={{ duration: 1.4, ease: EASE }}
        aria-hidden="true"
      >
        <span className="orbit-node orbit-node-one" />
        <span className="orbit-node orbit-node-two" />
        <span className="orbit-node orbit-node-three" />
      </motion.div>

      <div className="scope-kicker">GREENPAY <i /> BUSINESS PAYMENTS</div>
      <div className="scope-headline">
        <AnimatePresence mode="sync" initial={false}>
          <motion.h1
            key={beat >= 1 ? 'africa' : 'collect'}
            initial={{ opacity: 0, y: 50, scale: 0.88, filter: 'blur(9px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -25, scale: 1.08, filter: 'blur(7px)' }}
            transition={{ duration: 0.38, ease: EASE }}
          >
            {beat >= 1 ? <>ACROSS<br /><em>AFRICA.</em></> : 'COLLECT.'}
          </motion.h1>
        </AnimatePresence>
      </div>

      <motion.div
        className="scope-market"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: beat >= 2 ? 1 : 0, y: beat >= 2 ? 0 : 30 }}
        transition={{ duration: 0.36, ease: EASE }}
      >
        <strong>25</strong>
        <span><b>AFRICAN MARKETS</b><small>IN THE CURRENCY CATALOG</small></span>
      </motion.div>

      <motion.div
        className="scope-footnote"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: beat >= 3 ? 1 : 0, y: beat >= 3 ? 0 : 18 }}
        transition={{ duration: 0.3, ease: EASE }}
      >
        <span>USD GLOBALLY</span>
        <small>Collection options vary by currency and merchant verification.</small>
      </motion.div>

      <svg className="scope-route" viewBox="0 0 800 1200" fill="none" aria-hidden="true">
        <motion.path
          d="M111 813 C257 622 349 878 473 686 S653 509 721 636"
          stroke="#61c99b"
          strokeWidth="4"
          strokeLinecap="round"
          pathLength="1"
          initial={{ pathLength: 0, opacity: 0.55 }}
          animate={{ pathLength: beat >= 2 ? 1 : 0.46, opacity: 0.88 }}
          transition={{ duration: 1.1, ease: EASE }}
        />
        <circle cx="111" cy="813" r="12" fill="#e5b865" />
        <circle cx="473" cy="686" r="12" fill="#fffdf8" />
        <circle cx="721" cy="636" r="12" fill="#e5b865" />
      </svg>
      <motion.div
        className="scene-route-ring"
        initial={{ scale: 0.65, opacity: 0.7 }}
        animate={{ scale: beat >= 3 ? 1.08 : 0.82, opacity: 1 }}
        transition={{ duration: 0.9, ease: EASE }}
        aria-hidden="true"
      />
    </motion.section>
  );
}
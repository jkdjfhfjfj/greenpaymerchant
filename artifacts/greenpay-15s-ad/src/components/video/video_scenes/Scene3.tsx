import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;

export function Scene3() {
  const [beat, setBeat] = useState(0);
  useSceneTimer([
    { time: 850, callback: () => setBeat(1) },
    { time: 1650, callback: () => setBeat(2) },
    { time: 2850, callback: () => setBeat(3) },
  ]);

  return (
    <motion.section
      className="film-scene scene-api"
      initial={{ clipPath: 'inset(4% 7% 4% 7% round 8vmin)', scale: 1.08, opacity: 0.84 }}
      animate={{ clipPath: 'inset(0% 0% 0% 0% round 0vmin)', scale: 1, opacity: 1 }}
      exit={{ rotateY: -16, scale: 1.13, clipPath: 'circle(0% at 50% 48%)', opacity: 0 }}
      transition={{ duration: 0.48, ease: EASE }}
    >
      <div className="api-orbit" aria-hidden="true"><span /><i /><b /></div>
      <div className="api-kicker">02 / BUILD WITH GREENPAY</div>
      <AnimatePresence mode="sync" initial={false}>
        <motion.h2
          key={beat >= 2 ? 'records' : 'api'}
          className="api-headline"
          initial={{ opacity: 0, y: 34, filter: 'blur(8px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -18, scale: 1.04 }}
          transition={{ duration: 0.36, ease: EASE }}
        >
          {beat >= 2 ? <>CONFIRMED.<br /><em>RECORDED.</em></> : <>API IN.<br /><em>CLARITY OUT.</em></>}
        </motion.h2>
      </AnimatePresence>

      <motion.div
        className="api-board"
        initial={{ scale: 0.9, y: 60, rotate: 4, opacity: 0 }}
        animate={{ scale: 1, y: 0, rotate: 0, opacity: 1 }}
        exit={{ scale: 1.65, rotate: -4, opacity: 0, filter: 'blur(10px)' }}
        transition={{ type: 'spring', stiffness: 190, damping: 23, delay: 0.14 }}
      >
        <div className="api-request">
          <div className="api-window-top"><i /><i /><i /><span>GREENPAY API</span></div>
          <div className="api-request-body">
            <span className="api-method">POST</span>
            <code>/api/v1/payment-links</code>
          </div>
          <motion.div
            className="api-code-cursor"
            initial={{ scaleX: 0, transformOrigin: 'left' }}
            animate={{ scaleX: beat >= 1 ? 1 : 0.32 }}
            transition={{ duration: 0.65, ease: EASE }}
          />
        </div>

        <motion.div
          className="api-record"
          initial={{ clipPath: 'inset(50% 0 50% 0)' }}
          animate={{ clipPath: beat >= 1 ? 'inset(0% 0 0% 0)' : 'inset(42% 0 42% 0)' }}
          transition={{ duration: 0.7, ease: EASE }}
        >
          <div className="record-head">
            <span>TRANSACTION RECORD</span>
            <motion.b
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: beat >= 2 ? 1 : 0.7, opacity: beat >= 2 ? 1 : 0.25 }}
              transition={{ type: 'spring', stiffness: 360, damping: 18 }}
            >
              <Check size={13} strokeWidth={3} /> CONFIRMED
            </motion.b>
          </div>
          <div className="record-row"><span>REFERENCE</span><i /></div>
          <div className="record-row"><span>STATUS</span><i className="record-status" /></div>
          <div className="record-row"><span>FEE</span><i /></div>
          <div className="record-payout"><span>PAYOUT HISTORY</span><b>VIEW</b></div>
        </motion.div>
      </motion.div>

      <motion.p
        className="api-footnote"
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: beat >= 3 ? 1 : 0, x: beat >= 3 ? 0 : -20 }}
        transition={{ duration: 0.35, ease: EASE }}
      >
        Transactions, fees and payout records in one workspace.
      </motion.p>
    </motion.section>
  );
}
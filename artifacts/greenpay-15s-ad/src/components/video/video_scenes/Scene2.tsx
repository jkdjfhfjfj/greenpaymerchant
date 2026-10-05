import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, ArrowUpRight, FileText, Link2 } from 'lucide-react';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;

export function Scene2() {
  const [beat, setBeat] = useState(0);
  useSceneTimer([
    { time: 600, callback: () => setBeat(1) },
    { time: 1250, callback: () => setBeat(2) },
    { time: 1950, callback: () => setBeat(3) },
    { time: 2700, callback: () => setBeat(4) },
    { time: 3150, callback: () => setBeat(5) },
  ]);

  return (
    <motion.section
      className="film-scene invoice-scene"
      initial={{ clipPath: 'circle(0% at 50% 49%)', scale: 1.11, opacity: 0.82 }}
      animate={{ clipPath: 'circle(150% at 50% 49%)', scale: 1, opacity: 1 }}
      exit={{ clipPath: 'polygon(0 0, 100% 0, 100% 52%, 0 100%)', scale: 1.1, rotateX: 9, opacity: 0 }}
      transition={{ duration: 0.48, ease: EASE }}
    >
      <motion.img
        className="invoice-photo"
        src={`${import.meta.env.BASE_URL}images/classroom-teacher.jpg`}
        alt=""
        initial={{ scale: 1.1 }}
        animate={{ scale: 1.02 }}
        transition={{ duration: 3.55, ease: 'linear' }}
      />
      <div className="invoice-shade" aria-hidden="true" />

      <div className="invoice-topline">
        <span>FOR EVERYDAY BUSINESS</span>
        <span className="invoice-topline-mark"><FileText size={17} /></span>
      </div>
      <h2 className="invoice-headline">INVOICE <em>TO</em><br />PAYMENT LINK</h2>

      <div className="invoice-object-stage">
        <AnimatePresence mode="sync" initial={false}>
          {beat < 2 ? (
            <motion.article
              className="invoice-sheet"
              key="invoice"
              initial={{ y: 55, rotate: -7, scale: 0.84, opacity: 0 }}
              animate={{ y: beat >= 1 ? 0 : 12, rotate: beat >= 1 ? -2 : -5, scale: 1, opacity: 1 }}
              exit={{ rotateY: 82, x: 18, scale: 0.82, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 220, damping: 25 }}
            >
              <div className="invoice-sheet-head">
                <span>INVOICE</span>
                <FileText size={21} strokeWidth={1.8} />
              </div>
              <div className="invoice-lines" aria-hidden="true">
                <i /><i /><i />
              </div>
              <div className="invoice-total-rule" aria-hidden="true" />
              <strong>READY TO SHARE</strong>
            </motion.article>
          ) : (
            <motion.article
              className="invoice-link-card"
              key="payment-link"
              initial={{ rotateY: -74, y: 32, scale: 0.88, opacity: 0 }}
              animate={{ rotateY: 0, y: 0, scale: 1, opacity: 1 }}
              exit={{ scale: 1.12, x: 30, opacity: 0 }}
              transition={{ duration: 0.48, ease: EASE }}
            >
              <div className="invoice-link-label"><Link2 size={18} /> PAYMENT LINK</div>
              <div className="invoice-link-url">greenpay.co.ke/pay/…</div>
              <div className="invoice-link-footer"><span>SHARE WITH YOUR CUSTOMER</span><ArrowUpRight size={19} /></div>
            </motion.article>
          )}
        </AnimatePresence>
        <motion.div
          className="invoice-flow-arrow"
          initial={{ scaleX: 0.22, opacity: 0.4, transformOrigin: 'left' }}
          animate={{ scaleX: beat >= 2 ? 1 : 0.42, opacity: beat >= 2 ? 1 : 0.62 }}
          transition={{ duration: 0.55, ease: EASE }}
          aria-hidden="true"
        >
          <span><ArrowRight size={18} /></span>
        </motion.div>
      </div>

      <div className="invoice-methods">
        <motion.span
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: beat >= 3 ? 1 : 0, y: beat >= 3 ? 0 : 18 }}
          transition={{ duration: 0.32, ease: EASE }}
        >
          CARD PAYMENTS · WORLDWIDE
        </motion.span>
        <motion.span
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: beat >= 4 ? 1 : 0, y: beat >= 4 ? 0 : 18 }}
          transition={{ duration: 0.32, ease: EASE }}
        >
          M-PESA PROMPT · KENYA
        </motion.span>
      </div>

      <motion.div
        className="invoice-api-note"
        initial={{ opacity: 0, x: -18 }}
        animate={{ opacity: beat >= 5 ? 1 : 0, x: beat >= 5 ? 0 : -18 }}
        transition={{ duration: 0.3, ease: EASE }}
      >
        <i /> DEVELOPER API
      </motion.div>
    </motion.section>
  );
}
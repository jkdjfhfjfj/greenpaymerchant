import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;
const LESSON_STEPS = ['INVOICE', 'PAYMENT LINK', 'GET PAID'];

export function Scene1() {
  const [step, setStep] = useState(0);
  useSceneTimer([
    { time: 750, callback: () => setStep(1) },
    { time: 1350, callback: () => setStep(2) },
    { time: 1900, callback: () => setStep(3) },
  ]);

  return (
    <motion.section
      className="film-scene classroom-scene"
      initial={{ clipPath: 'circle(96% at 50% 49%)', scale: 1.03, opacity: 0.9 }}
      animate={{ clipPath: 'circle(150% at 50% 49%)', scale: 1, opacity: 1 }}
      exit={{ clipPath: 'circle(0% at 50% 49%)', scale: 1.15, rotate: 2, opacity: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <motion.img
        className="classroom-photo"
        src={`${import.meta.env.BASE_URL}images/classroom-teacher.jpg`}
        alt=""
        initial={{ scale: 1.08, x: 0 }}
        animate={{ scale: 1.02, x: '-1.2%' }}
        transition={{ duration: 3.15, ease: 'linear' }}
      />
      <div className="classroom-shade" aria-hidden="true" />

      <div className="classroom-brand">GREENPAY <i /> BUSINESS PAYMENTS</div>
      <div className="classroom-boardcopy">
        <motion.p
          className="classroom-eyebrow"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: EASE }}
        >
          TODAY’S LESSON
        </motion.p>
        <AnimatePresence mode="sync" initial={false}>
          <motion.h1
            key={step >= 3 ? 'collect' : LESSON_STEPS[step]}
            initial={{ opacity: 0, y: 24, scale: 0.92, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -18, scale: 1.04, filter: 'blur(5px)' }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            {step >= 3 ? <><em>A SIMPLER WAY</em><br />TO COLLECT.</> : LESSON_STEPS[step]}
          </motion.h1>
        </AnimatePresence>
        <motion.div
          className="classroom-chalk-line"
          initial={{ scaleX: 0, transformOrigin: 'left' }}
          animate={{ scaleX: step >= 1 ? 1 : 0.35 }}
          transition={{ duration: 0.45, ease: EASE }}
        />
      </div>

      <motion.div
        className="classroom-subline"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: step >= 2 ? 1 : 0, y: step >= 2 ? 0 : 18 }}
        transition={{ duration: 0.34, ease: EASE }}
      >
        INVOICE <i /> PAYMENT LINK <i /> PAID
      </motion.div>

      <motion.div
        className="classroom-loop-ring"
        initial={{ scale: 0.7, opacity: 0.72 }}
        animate={{ scale: step >= 3 ? 1.1 : 0.88, opacity: 1, rotate: step >= 3 ? 18 : 0 }}
        transition={{ duration: 0.9, ease: EASE }}
        aria-hidden="true"
      />
    </motion.section>
  );
}
import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;
const LEFT_MARKETS = [
  'Benin', 'Burkina Faso', 'Cameroon', 'Central African Republic', 'Chad',
  'Côte d’Ivoire', 'DR Congo', 'Equatorial Guinea', 'Gabon', 'Guinea-Bissau',
];
const RIGHT_MARKETS = [
  'Kenya', 'Mali', 'Niger', 'Nigeria', 'Republic of the Congo',
  'Rwanda', 'Senegal', 'Togo', 'Uganda', 'Zambia',
];

export function Scene3() {
  const [beat, setBeat] = useState(0);
  useSceneTimer([
    { time: 420, callback: () => setBeat(1) },
    { time: 2350, callback: () => setBeat(2) },
    { time: 2750, callback: () => setBeat(3) },
    { time: 4000, callback: () => setBeat(4) },
    { time: 4300, callback: () => setBeat(5) },
  ]);

  const renderCountries = (countries: string[], column: number) => countries.map((country, index) => (
    <motion.li
      key={country}
      initial={{ opacity: 0, x: column === 0 ? -14 : 14 }}
      animate={{ opacity: beat >= 1 ? 1 : 0, x: beat >= 1 ? 0 : column === 0 ? -14 : 14 }}
      transition={{ duration: 0.25, delay: 0.4 + index * 0.045, ease: EASE }}
    >
      <i />
      <span>{country}</span>
    </motion.li>
  ));

  return (
    <motion.section
      className="film-scene markets-scene"
      initial={{ clipPath: 'polygon(0 0, 100% 0, 100% 0, 0 38%)', scale: 1.08, opacity: 0.84 }}
      animate={{ clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)', scale: 1, opacity: 1 }}
      exit={{ clipPath: 'circle(0% at 50% 49%)', scale: 1.13, rotateY: -10, opacity: 0 }}
      transition={{ duration: 0.52, ease: EASE }}
    >
      <div className="markets-chalk-dust" aria-hidden="true" />
      <div className="markets-wood-rail" aria-hidden="true" />
      <div className="markets-eyebrow">GREENPAY · CURRENT COLLECTION MARKETS</div>
      <motion.div
        className="markets-incoming-rail"
        initial={{ scaleX: 0, opacity: 0.7, transformOrigin: 'left' }}
        animate={{ scaleX: 1, opacity: 1 }}
        transition={{ duration: 0.45, ease: EASE }}
        aria-hidden="true"
      />

      <motion.h2
        className="markets-title"
        initial={{ opacity: 0, y: 20, scale: 0.96 }}
        animate={{ opacity: beat >= 1 ? 1 : 0, y: beat >= 1 ? 0 : 20, scale: beat >= 1 ? 1 : 0.96 }}
        transition={{ duration: 0.36, ease: EASE }}
      >
        <strong>20</strong> AFRICAN MARKETS
      </motion.h2>

      <div className="markets-grid" aria-label="Currently collection-ready countries">
        <ul>{renderCountries(LEFT_MARKETS, 0)}</ul>
        <ul>{renderCountries(RIGHT_MARKETS, 1)}</ul>
      </div>

      <div className="markets-methods">
        <motion.span
          className="method-pill method-mobile"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: beat >= 2 ? 1 : 0, y: beat >= 2 ? 0 : 18 }}
          transition={{ duration: 0.33, ease: EASE }}
        >
          M-PESA PROMPT <i /> KENYA
        </motion.span>
        <motion.span
          className="method-pill method-card"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: beat >= 3 ? 1 : 0, y: beat >= 3 ? 0 : 18 }}
          transition={{ duration: 0.33, ease: EASE }}
        >
          CARD <i /> WHERE AVAILABLE
        </motion.span>
      </div>

      <motion.div
        className="markets-availability"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: beat >= 4 ? 1 : 0, y: beat >= 4 ? 0 : 14 }}
        transition={{ duration: 0.32, ease: EASE }}
      >
        <strong>USD GLOBALLY</strong>
        <span>Options vary by currency and merchant verification.</span>
      </motion.div>

      <motion.div
        className="markets-loop-ring"
        initial={{ scale: 0.45, opacity: 0 }}
        animate={{ scale: beat >= 5 ? 12 : 0.45, opacity: beat >= 5 ? 0.8 : 0 }}
        transition={{ duration: 0.72, ease: EASE }}
        aria-hidden="true"
      />
    </motion.section>
  );
}
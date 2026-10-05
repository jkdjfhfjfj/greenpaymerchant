import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const EASE = [0.22, 1, 0.36, 1] as const;
type CurrencyItem = { code: string; name: string };
const LEFT_CURRENCIES: CurrencyItem[] = [
  { code: 'USD', name: 'US Dollar' },
  { code: 'KES', name: 'Kenyan Shilling' },
  { code: 'NGN', name: 'Nigerian Naira' },
  { code: 'GHS', name: 'Ghanaian Cedi' },
  { code: 'TZS', name: 'Tanzanian Shilling' },
  { code: 'XOF', name: 'West African CFA Franc' },
  { code: 'RWF', name: 'Rwandan Franc' },
];
const RIGHT_CURRENCIES: CurrencyItem[] = [
  { code: 'UGX', name: 'Ugandan Shilling' },
  { code: 'ZMW', name: 'Zambian Kwacha' },
  { code: 'MWK', name: 'Malawian Kwacha' },
  { code: 'SLL', name: 'Sierra Leonean Leone' },
  { code: 'CDF', name: 'Congolese Franc' },
  { code: 'MZN', name: 'Mozambican Metical' },
  { code: 'XAF', name: 'Central African CFA Franc' },
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

  const renderCurrencies = (currencies: CurrencyItem[], column: number) => currencies.map((currency, index) => (
    <motion.li
      key={currency.code}
      initial={{ opacity: 0, x: column === 0 ? -14 : 14 }}
      animate={{ opacity: beat >= 1 ? 1 : 0, x: beat >= 1 ? 0 : column === 0 ? -14 : 14 }}
      transition={{ duration: 0.25, delay: 0.4 + index * 0.045, ease: EASE }}
    >
      <i />
      <strong>{currency.code}</strong>
      <span>{currency.name}</span>
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
      <div className="markets-eyebrow">GREENPAY · SUPPORTED CURRENCIES</div>
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
        <strong>14</strong> SUPPORTED CURRENCIES
      </motion.h2>

      <div className="markets-grid" aria-label="14 supported currencies">
        <ul>{renderCurrencies(LEFT_CURRENCIES, 0)}</ul>
        <ul>{renderCurrencies(RIGHT_CURRENCIES, 1)}</ul>
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
          CARDS <i /> WORLDWIDE
        </motion.span>
      </div>

      <motion.div
        className="markets-availability"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: beat >= 4 ? 1 : 0, y: beat >= 4 ? 0 : 14 }}
        transition={{ duration: 0.32, ease: EASE }}
      >
        <strong>GLOBAL CARD PAYMENTS</strong>
        <span>Plus an M-Pesa prompt in Kenya.</span>
      </motion.div>

      <motion.div
        className="markets-loop-ring"
        initial={{ scale: 0.45, opacity: 0 }}
        animate={{
          scale: beat >= 5 ? 8 : 0.45,
          opacity: beat >= 5 ? 0.72 : 0,
          borderWidth: beat >= 5 ? '0.08vmin' : '0.38vmin',
        }}
        transition={{ duration: 0.72, ease: EASE }}
        aria-hidden="true"
      />
    </motion.section>
  );
}
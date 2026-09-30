import React, { useState } from 'react';
import { ArrowLeft, AlertCircle, CheckCircle2 } from 'lucide-react';
import { BRAND } from '../brand';
import type { Role } from '../data/prefs';
import { store } from '../data/store';
import { navigate } from '../router';
import '../styles/auth.css';

export type AuthMode = 'signin' | 'signup' | 'forgot-password';

interface AuthScreenProps {
  initialMode?: AuthMode;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ initialMode = 'signup' }) => {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('farmer');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'form' | 'otp'>('form');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [dryRunCode, setDryRunCode] = useState<string | null>(null);

  const lang = store.state.lang;
  const isSw = lang === 'sw';

  const handleModeChange = (newMode: AuthMode) => {
    setMode(newMode);
    setStep('form');
    setError(null);
    setInfoMessage(null);
    setDryRunCode(null);
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);

    try {
      if (!phone.trim()) throw new Error(isSw ? 'Tafadhali weka namba ya simu' : 'Please enter a valid phone number');

      if (mode === 'signup') {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, name, role, pin, lang }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.error === 'user_exists') {
            setInfoMessage(isSw ? 'Namba hii tayari ina akaunti. Tafadhali Ingia.' : 'An account with this phone number already exists. Please Sign In.');
            setMode('signin');
            return;
          }
          throw new Error(data.message || data.error || (isSw ? 'Usajili umefeli' : 'Failed to register'));
        }
        if (data.dryRun) {
          setDryRunCode(isSw ? 'SMS Jaribio: Msimbo umeombwa.' : 'SMS Dry-Run Active: OTP code requested.');
        }
        setStep('otp');
        setInfoMessage(isSw ? `SMS yenye msimbo imetumwa kwenda ${phone}` : `Verification SMS sent to ${phone}`);
      } else if (mode === 'forgot-password') {
        const res = await fetch('/api/auth/request-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, lang }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || (isSw ? 'Imefeli kutuma msimbo' : 'Failed to send reset code'));
        setStep('otp');
        setInfoMessage(isSw ? 'Weka msimbo wa SMS pamoja na PIN mpya' : 'Verification code sent. Enter it below with your new PIN.');
      } else {
        // Sign In mode
        if (pin && pin.length >= 4) {
          const res = await fetch('/api/auth/login-pass', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, pin }),
          });
          const data = await res.json();
          if (res.ok && data.user) {
            store.setRole(data.user.role);
            navigate(data.user.role, data.user.role === 'lender' ? 'portfolio' : data.user.role === 'extension' ? 'farms' : 'home');
            return;
          }
        }
        const res = await fetch('/api/auth/request-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, lang }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || (isSw ? 'Kosa katika kuomba msimbo' : 'Failed to request OTP code'));
        setStep('otp');
        setInfoMessage(isSw ? 'Msimbo wa SMS umetumwa!' : 'One-Time SMS verification code sent!');
      }
    } catch (err: any) {
      setError(err.message || (isSw ? 'Imetokea shida. Jaribu tena.' : 'An error occurred. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === 'forgot-password') {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, code, newPin: pin }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || (isSw ? 'Imefeli kubadili PIN' : 'Failed to reset password'));
        store.setRole(data.user.role);
        navigate(data.user.role, data.user.role === 'lender' ? 'portfolio' : data.user.role === 'extension' ? 'farms' : 'home');
      } else {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, code, role, name, pin }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || (isSw ? 'Msimbo si sahihi' : 'Invalid code or authentication failed'));
        store.setRole(data.user.role);
        navigate(data.user.role, data.user.role === 'lender' ? 'portfolio' : data.user.role === 'extension' ? 'farms' : 'home');
      }
    } catch (err: any) {
      setError(err.message || (isSw ? 'Uhakiki umefeli' : 'Verification failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ziwa-auth-screen">
      {/* Left Panel: Official Logo & Brand Section */}
      <div className="ziwa-left-panel">
        <div />

        {/* Official Ziwa Data Logo SVG */}
        <img
          src="/logo/Asset 2.svg"
          alt="Ziwa Data Logo"
          className="ziwa-logo-img"
        />

        {/* Left Subtitle & Footer */}
        <div>
          <p className="ziwa-left-subtitle">
            {isSw
              ? 'Mfumo wa tahadhari ya mapema na kumbukumbu zilizohakikiwa kwa wafugaji wa samaki Ziwa Victoria.'
              : 'Early warning and verified record platform for Lake Victoria cage fish farmers.'}
          </p>

          <div className="ziwa-left-footer justify-center">
            <span>powered by</span>
            <strong className="text-white font-bold tracking-wider">KijaniSpace</strong>
          </div>
        </div>
      </div>

      {/* Right Panel: Form Section */}
      <div className="ziwa-right-panel">
        <div className="ziwa-form-container">
          {/* Back link */}
          <button
            type="button"
            onClick={() => {
              if (step === 'otp') {
                setStep('form');
              } else {
                window.location.hash = '#/landing';
              }
            }}
            className="ziwa-back-btn"
          >
            <ArrowLeft size={16} />
            <span>
              {step === 'otp'
                ? isSw ? 'Rudi nyuma' : 'Back to form'
                : isSw ? 'Rudi Mwanzo' : 'Back to Landing Page'}
            </span>
          </button>

          {/* Title */}
          <h1 className="ziwa-card-title">
            {mode === 'signup'
              ? isSw ? 'Jisajili' : 'Sign Up'
              : mode === 'signin'
              ? isSw ? 'Ingia' : 'Sign In'
              : isSw ? 'Badili PIN' : 'Reset PIN'}
          </h1>

          {error && (
            <div className="mb-4 p-3.5 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-xs flex items-center gap-2">
              <AlertCircle size={16} className="text-red-500 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {infoMessage && (
            <div className="mb-4 p-3.5 rounded-2xl bg-cyan-50 border border-cyan-200 text-cyan-800 text-xs flex items-center gap-2">
              <CheckCircle2 size={16} className="text-[#2DA8A8] shrink-0" />
              <span>{infoMessage}</span>
            </div>
          )}

          {dryRunCode && (
            <div className="mb-4 p-3.5 rounded-2xl bg-slate-100 border border-slate-300 text-slate-700 text-xs font-mono">
              {dryRunCode}
            </div>
          )}

          {step === 'form' ? (
            <form onSubmit={handleRequestOtp} className="ziwa-form-stack">
              {mode === 'signup' && (
                <input
                  type="text"
                  className="ziwa-input"
                  placeholder={isSw ? 'Jina la mvuvi' : 'Name'}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              )}

              <input
                type="tel"
                className="ziwa-input"
                placeholder={isSw ? 'Namba ya simu' : 'Phone number'}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />

              {mode === 'signup' && (
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-1.5 px-2">
                    {isSw ? 'Chagua Wajibu:' : 'Select Role:'}
                  </div>
                  <div className="ziwa-role-selector">
                    <button
                      type="button"
                      className={`ziwa-role-pill ${role === 'farmer' ? 'active' : ''}`}
                      onClick={() => setRole('farmer')}
                    >
                      {isSw ? 'Mvuvi' : 'Farmer'}
                    </button>
                    <button
                      type="button"
                      className={`ziwa-role-pill ${role === 'lender' ? 'active' : ''}`}
                      onClick={() => setRole('lender')}
                    >
                      {isSw ? 'Benki' : 'Lender'}
                    </button>
                    <button
                      type="button"
                      className={`ziwa-role-pill ${role === 'extension' ? 'active' : ''}`}
                      onClick={() => setRole('extension')}
                    >
                      {isSw ? 'Ugani' : 'Extension'}
                    </button>
                  </div>
                </div>
              )}

              <input
                type="password"
                className="ziwa-input"
                placeholder={
                  mode === 'signup'
                    ? isSw ? 'Tengeneza PIN' : 'Create PIN'
                    : isSw ? 'Weka PIN' : 'PIN'
                }
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                required={mode === 'signup' || mode === 'forgot-password'}
              />

              {mode === 'signin' && (
                <div className="text-right">
                  <button
                    type="button"
                    onClick={() => handleModeChange('forgot-password')}
                    className="text-xs font-semibold text-[#2DA8A8] hover:underline"
                  >
                    {isSw ? 'Umesahau PIN?' : 'Forgot PIN?'}
                  </button>
                </div>
              )}

              <button type="submit" disabled={loading} className="ziwa-btn-submit">
                {loading
                  ? isSw ? 'Inachakata...' : 'Processing...'
                  : mode === 'signup'
                  ? isSw ? 'Maliza usajili' : 'Sign Up'
                  : mode === 'signin'
                  ? isSw ? 'Ingia' : 'Sign In'
                  : isSw ? 'Tuma Msimbo' : 'Send Reset Code'}
              </button>

              <div className="text-center text-xs text-slate-500 mt-2">
                {mode === 'signup' ? (
                  <>
                    {isSw ? 'Una akaunti tayari?' : 'Already have an account?'}{' '}
                    <span onClick={() => handleModeChange('signin')} className="text-[#2DA8A8] font-bold cursor-pointer hover:underline">
                      {isSw ? 'Ingia' : 'Sign In'}
                    </span>
                  </>
                ) : (
                  <>
                    {isSw ? 'Huna akaunti?' : "Don't have an account?"}{' '}
                    <span onClick={() => handleModeChange('signup')} className="text-[#2DA8A8] font-bold cursor-pointer hover:underline">
                      {isSw ? 'Jisajili' : 'Sign Up'}
                    </span>
                  </>
                )}
              </div>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="ziwa-form-stack">
              <input
                type="text"
                className="ziwa-input font-mono tracking-widest text-center text-lg"
                placeholder={isSw ? 'Msimbo wa SMS' : 'SMS Code'}
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
              />

              {mode === 'forgot-password' && (
                <input
                  type="password"
                  className="ziwa-input"
                  placeholder={isSw ? 'Weka PIN mpya' : 'Confirm New PIN'}
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  required
                />
              )}

              <button type="submit" disabled={loading} className="ziwa-btn-submit">
                {loading ? (isSw ? 'Inahakiki...' : 'Verifying...') : (isSw ? 'Kamilisha' : 'Complete Verification')}
              </button>
            </form>
          )}

          {/* Quick Demo Credentials Section */}
          <div className="ziwa-demo-presets-card">
            <div className="ziwa-demo-presets-header">
              <div className="ziwa-demo-presets-badge">
                ⚡ {isSw ? 'JARIBIO LA MOJA KWA MOJA' : 'DEMO QUICK LOGIN'}
              </div>
              <p className="ziwa-demo-presets-desc">
                {isSw
                  ? 'Chagua mhusika kuingia moja kwa moja kwenye dashibodi maalum:'
                  : 'Select a demo persona to instantly sign in and launch their dashboard:'}
              </p>
            </div>

            <div className="ziwa-demo-buttons-grid">
              <button
                type="button"
                className="ziwa-demo-btn ziwa-demo-btn--farmer"
                onClick={() => {
                  store.setRole('farmer');
                  navigate('farmer', 'home');
                }}
              >
                <div className="ziwa-demo-btn-title">
                  <span>🌾 {isSw ? 'Mvuvi (Cage Owner)' : 'Farmer (Cage Owner)'}</span>
                </div>
                <div className="ziwa-demo-btn-sub">
                  Juma Mtabazi • +255 712 345 678
                </div>
              </button>

              <button
                type="button"
                className="ziwa-demo-btn ziwa-demo-btn--lender"
                onClick={() => {
                  store.setRole('lender');
                  navigate('lender', 'portfolio');
                }}
              >
                <div className="ziwa-demo-btn-title">
                  <span>🏦 {isSw ? 'Mkopeshi (Bank Lender)' : 'Lender (Bank Officer)'}</span>
                </div>
                <div className="ziwa-demo-btn-sub">
                  NMB Credit Officer • +255 787 654 321
                </div>
              </button>

              <button
                type="button"
                className="ziwa-demo-btn ziwa-demo-btn--extension"
                onClick={() => {
                  store.setRole('extension');
                  navigate('extension', 'farms');
                }}
              >
                <div className="ziwa-demo-btn-title">
                  <span>🛡️ {isSw ? 'Afisa Ugani (Extension)' : 'Extension Officer'}</span>
                </div>
                <div className="ziwa-demo-btn-sub">
                  Dr. Amina Kilimo • +255 754 000 111
                </div>
              </button>
            </div>
          </div>
        </div>

        {/* Footer KijaniSpace branding */}
        <div className="ziwa-footer-branding">
          <span>powered by</span>
          <span className="ziwa-kijani-logo">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v10M7 12h10" />
            </svg>
            KijaniSpace
          </span>
        </div>
      </div>
    </div>
  );
};

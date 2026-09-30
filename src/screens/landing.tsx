import React, { useEffect, useState } from 'react';
import { Fish, ShieldCheck, Briefcase, Bell, Gauge, Database, ArrowRight, CheckCircle2, CloudSun, Wind, Thermometer, Droplets, Sparkles, Layers, Activity, Lock, QrCode, Smartphone, Globe, Shield } from 'lucide-react';
import { BRAND } from '../brand';
import { fetchLiveLakeData, type OpenMeteoLive } from '../data/openMeteo';
import { store } from '../data/store';
import { navigate } from '../router';
import { ShareModal } from '../ui/ShareModal';
import '../styles/landing.css';
import '../styles/auth.css';

export const LandingScreen: React.FC = () => {
  const [lakeData, setLakeData] = useState<OpenMeteoLive | null>(null);
  const [loadingLake, setLoadingLake] = useState(true);
  const [selectedRoleTab, setSelectedRoleTab] = useState<'farmer' | 'lender' | 'extension'>('farmer');
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    fetchLiveLakeData()
      .then((res) => {
        setLakeData(res.live);
      })
      .catch((err) => {
        console.warn('Open-Meteo live fetch fallback:', err);
      })
      .finally(() => setLoadingLake(false));
  }, []);

  return (
    <div className="ziwa-landing">
      {/* Top Navigation Bar */}
      <nav className="ziwa-nav">
        <div className="ziwa-container ziwa-nav-inner">
          <a href="#/landing" className="ziwa-nav-brand">
            <img src="/logo/Asset 2.svg" alt="Ziwa Data Logo" className="ziwa-nav-logo" />
          </a>

          <div className="ziwa-nav-links">
            <a href="#live-data" className="ziwa-nav-link">Live Lake Data</a>
            <a href="#roles" className="ziwa-nav-link">Role OS</a>
            <a href="#verification" className="ziwa-nav-link">Hashchain Ledger</a>
          </div>

          <div className="ziwa-nav-actions">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setShareOpen(true);
              }}
              className="ziwa-btn-qr"
              title="Scan QR Code to open demo on mobile over Wi-Fi"
            >
              <QrCode size={16} />
              <span>Wi-Fi QR</span>
            </button>

            <a href="#/auth/signin" className="ziwa-btn-signin">
              Sign In
            </a>

            <a href="#/auth/signup" className="ziwa-btn-getstarted">
              Get Started →
            </a>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="ziwa-hero-section">
        <div className="ziwa-container">
          <div className="ziwa-hero-grid">
            <div>
              <div className="ziwa-hero-badge">
                <Sparkles size={14} />
                <span>Early Warnings & Verified Records for Lake Victoria</span>
              </div>

              <h1 className="ziwa-hero-title">
                Cryptographic Security & Real-Time Warning for Cage Farmers.
              </h1>

              <p className="ziwa-hero-desc">
                Protect your cage fish stock from dissolved oxygen crashes and lake turnovers — while building an immutable SHA-256 cryptographic record verified by financial lenders and extension officers.
              </p>

              <div className="ziwa-hero-actions">
                <a href="#/auth/signup" className="ziwa-btn-primary-lg">
                  <span>Get Started Free</span>
                  <ArrowRight size={18} />
                </a>

                <button
                  type="button"
                  onClick={() => navigate('farmer', 'home')}
                  className="ziwa-btn-secondary-lg"
                >
                  <Activity size={18} style={{ color: '#0A5160' }} />
                  <span>Explore Guest Demo</span>
                </button>
              </div>

              <div className="ziwa-hero-features">
                <div className="ziwa-hero-feature-item">
                  <CheckCircle2 size={16} style={{ color: '#0A5160' }} />
                  <span>Offline-First Engine</span>
                </div>
                <div className="ziwa-hero-feature-item">
                  <CheckCircle2 size={16} style={{ color: '#0A5160' }} />
                  <span>Open-Meteo Integration</span>
                </div>
                <div className="ziwa-hero-feature-item">
                  <CheckCircle2 size={16} style={{ color: '#0A5160' }} />
                  <span>Beem SMS Alerts</span>
                </div>
              </div>
            </div>

            {/* Hero Telemetry Card (Dark Accent for Contrast) */}
            <div className="ziwa-preview-card">
              <div className="ziwa-card-header">
                <div className="ziwa-card-location">
                  <div className="ziwa-pulse-dot" />
                  <span>Mwanza Gulf • Lake Victoria</span>
                </div>
                <div className="ziwa-stream-badge">
                  Live Stream
                </div>
              </div>

              <div className="ziwa-metrics-grid">
                <div className="ziwa-metric-box">
                  <div className="ziwa-metric-label">
                    <Droplets size={14} style={{ color: '#38BDF8' }} /> Est. Dissolved Oxygen
                  </div>
                  <div className="ziwa-metric-value">
                    {lakeData ? `${lakeData.estimatedDO} mg/L` : '7.4 mg/L'}
                  </div>
                  <div className="ziwa-metric-sub" style={{ color: '#10B981' }}>Optimal Stocking</div>
                </div>

                <div className="ziwa-metric-box">
                  <div className="ziwa-metric-label">
                    <Wind size={14} style={{ color: '#38BDF8' }} /> Wind & Gusts
                  </div>
                  <div className="ziwa-metric-value" style={{ color: '#38BDF8' }}>
                    {lakeData ? `${lakeData.windSpeed} km/h` : '14 km/h'}
                  </div>
                  <div className="ziwa-metric-sub" style={{ color: '#A6BDC8' }}>
                    Gusts: {lakeData ? `${lakeData.windGusts} km/h` : '20 km/h'}
                  </div>
                </div>
              </div>

              <div className="ziwa-ledger-banner">
                <Shield size={22} style={{ color: '#5ECFE0', flexShrink: 0 }} />
                <div>
                  <div className="ziwa-ledger-title">SHA-256 Cryptographic Hashchain</div>
                  <div className="ziwa-ledger-sub">Every cage reading forms an unbroken tamper-proof ledger block.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Live Telemetry Section (Bright White Card Grid) */}
      <section id="live-data" className="ziwa-section">
        <div className="ziwa-container">
          <div className="ziwa-section-header">
            <span className="ziwa-section-subtitle">
              REAL-TIME OPEN-METEO TELEMETRY
            </span>
            <h2 className="ziwa-section-title">
              Live Lake Victoria Environmental Telemetry
            </h2>
            <p className="ziwa-section-desc">
              Real-time coordinates (-2.5167, 32.9000) streaming directly from satellite & weather data.
            </p>
          </div>

          {loadingLake ? (
            <div style={{ padding: '3rem', textAlign: 'center', color: '#64748B', fontFamily: 'monospace' }}>
              Loading live telemetry...
            </div>
          ) : (
            <div className="ziwa-telemetry-grid">
              <div className="ziwa-telemetry-card">
                <div className="ziwa-telemetry-head">
                  <span>Surface Air Temp</span>
                  <Thermometer size={20} style={{ color: '#0A5160' }} />
                </div>
                <div className="ziwa-telemetry-val">
                  {lakeData?.temperature}°C
                </div>
                <div className="ziwa-telemetry-foot">Mwanza Gulf Ambient</div>
              </div>

              <div className="ziwa-telemetry-card">
                <div className="ziwa-telemetry-head">
                  <span>Turnover Risk</span>
                  <Activity size={20} style={{ color: '#0A5160' }} />
                </div>
                <div className="ziwa-telemetry-val" style={{ color: '#10B981', textTransform: 'capitalize' }}>
                  {lakeData?.turnoverRisk}
                </div>
                <div className="ziwa-telemetry-foot">Wind & Pressure Algorithm</div>
              </div>

              <div className="ziwa-telemetry-card">
                <div className="ziwa-telemetry-head">
                  <span>Surface Pressure</span>
                  <Layers size={20} style={{ color: '#0A5160' }} />
                </div>
                <div className="ziwa-telemetry-val">
                  {lakeData?.surfacePressure} hPa
                </div>
                <div className="ziwa-telemetry-foot">Altitude ~1134m</div>
              </div>

              <div className="ziwa-telemetry-card">
                <div className="ziwa-telemetry-head">
                  <span>Weather Conditions</span>
                  <CloudSun size={20} style={{ color: '#D97706' }} />
                </div>
                <div className="ziwa-telemetry-val" style={{ fontSize: '1.25rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {lakeData?.weatherDesc}
                </div>
                <div className="ziwa-telemetry-foot">Rain: {lakeData?.precipitation} mm</div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Role Ecosystem OS Section */}
      <section id="roles" className="ziwa-section-alt">
        <div className="ziwa-container">
          <div className="ziwa-section-header">
            <h2 className="ziwa-section-title">
              Built for the Entire Aquaculture Ecosystem
            </h2>
            <p className="ziwa-section-desc">
              Role-based operating views for cage farmers, financial lenders, and fisheries extension officers.
            </p>
          </div>

          <div className="ziwa-role-tabs">
            <button
              type="button"
              onClick={() => setSelectedRoleTab('farmer')}
              className={`ziwa-role-tab-btn ${selectedRoleTab === 'farmer' ? 'active' : ''}`}
            >
              <Fish size={18} />
              <span>Farmer OS</span>
            </button>

            <button
              type="button"
              onClick={() => setSelectedRoleTab('lender')}
              className={`ziwa-role-tab-btn ${selectedRoleTab === 'lender' ? 'active' : ''}`}
            >
              <Briefcase size={18} />
              <span>Lender OS</span>
            </button>

            <button
              type="button"
              onClick={() => setSelectedRoleTab('extension')}
              className={`ziwa-role-tab-btn ${selectedRoleTab === 'extension' ? 'active' : ''}`}
            >
              <ShieldCheck size={18} />
              <span>Extension OS</span>
            </button>
          </div>

          <div className="ziwa-role-content">
            <div>
              <div className="ziwa-hero-badge">
                <span>✦ {selectedRoleTab.toUpperCase()} WORKFLOW</span>
              </div>

              <h3 className="ziwa-section-title" style={{ fontSize: '1.5rem', textAlign: 'left', margin: '1rem 0' }}>
                {selectedRoleTab === 'farmer'
                  ? 'Real-Time Cage Alerts & Offline Record Keeping'
                  : selectedRoleTab === 'lender'
                  ? 'Verified Credit Scoring & Risk Portfolio Monitoring'
                  : 'Official Farm Attestations & Water Quality Audits'}
              </h3>

              <p className="ziwa-section-desc" style={{ fontSize: '0.95rem', marginBottom: '2rem' }}>
                {selectedRoleTab === 'farmer'
                  ? 'Record dissolved oxygen, pH, water temp, and mortality right from your phone — even offline. Get automated SMS warnings before oxygen drops harm your fish.'
                  : selectedRoleTab === 'lender'
                  ? 'Review verified, tamper-evident record histories for loan underwriting. Audit unbroken cryptographic chains to disburse tranches with full confidence.'
                  : 'Conduct official site visits, verify farmer cage counts, log water quality samples, and issue tamper-proof attestations on the ledger.'}
              </p>

              <button
                type="button"
                onClick={() => {
                  store.setRole(selectedRoleTab);
                  navigate(selectedRoleTab, selectedRoleTab === 'lender' ? 'portfolio' : selectedRoleTab === 'extension' ? 'farms' : 'home');
                }}
                className="ziwa-btn-primary-lg"
                style={{ padding: '0.85rem 1.75rem', fontSize: '0.95rem' }}
              >
                <span>Launch {selectedRoleTab.toUpperCase()} Dashboard</span>
                <ArrowRight size={16} />
              </button>
            </div>

            <div className="ziwa-role-feature-list">
              <div className="ziwa-role-feature-card">
                <Bell size={22} style={{ color: '#0A5160' }} />
                <div>
                  <div className="ziwa-ledger-title">Automated SMS Early Warnings</div>
                  <div className="ziwa-ledger-sub">Direct integration via Beem SMS API.</div>
                </div>
              </div>

              <div className="ziwa-role-feature-card">
                <Database size={22} style={{ color: '#0A5160' }} />
                <div>
                  <div className="ziwa-ledger-title">Offline-First IndexedDB Engine</div>
                  <div className="ziwa-ledger-sub">Saves locally and syncs automatically when online.</div>
                </div>
              </div>

              <div className="ziwa-role-feature-card">
                <Gauge size={22} style={{ color: '#0A5160' }} />
                <div>
                  <div className="ziwa-ledger-title">Transparent Credit Matrix (0-100)</div>
                  <div className="ziwa-ledger-sub">Rule-based score evaluation for financial lenders.</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="ziwa-container">
        <div className="ziwa-footer">
          <div>
            © 2026 {BRAND.name}. Early-warning and verified-record platform for Lake Victoria.
          </div>
          <div className="ziwa-footer-links">
            <a href="#/auth/signin">Sign In</a>
            <a href="#/auth/signup">Create Account</a>
            <a href="#/farmer/home">Guest Demo</a>
          </div>
        </div>
      </footer>

      {/* Wi-Fi QR Code Share Modal */}
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { QrCode, Copy, Check, X, Wifi, Monitor, Smartphone, Share2 } from 'lucide-react';

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({ open, onClose }) => {
  const [ips, setIps] = useState<string[]>([]);
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [port, setPort] = useState<number>(5173);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'qr' | 'url'>('qr'); // Default to QR code view!

  useEffect(() => {
    if (!open) return;

    // Fetch local network IP from backend
    fetch('/api/network-info')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.ips) && data.ips.length > 0) {
          setIps(data.ips);
          setSelectedIp(data.primaryIp || data.ips[0]);
        }
        if (data.port) {
          setPort(data.port);
        }
      })
      .catch(() => {
        const host = window.location.hostname;
        if (host !== 'localhost' && host !== '127.0.0.1') {
          setIps([host]);
          setSelectedIp(host);
        }
      });
  }, [open]);

  // Construct full URL for local Wi-Fi access
  const host = selectedIp || (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' ? window.location.hostname : '192.168.0.104');
  const currentPort = window.location.port || port || '5173';
  const shareUrl = `http://${host}:${currentPort}/#/landing`;

  // QR Code image URL generated via public API
  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(shareUrl)}&margin=10&color=0A5160&bgcolor=FFFFFF`;

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[999999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-md bg-[#0C2630] border border-[#1D3743] rounded-3xl p-6 text-[#EAF4F8] shadow-2xl overflow-hidden">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 p-2.5 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer z-10"
          aria-label="Close"
        >
          <X size={20} />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3.5 mb-4">
          <div className="p-3 rounded-2xl bg-[#2DA8A8]/20 text-[#2DA8A8]">
            <QrCode size={26} />
          </div>
          <div>
            <h3 className="text-xl font-bold text-white">Scan Wi-Fi QR Code</h3>
            <p className="text-xs text-slate-400">Open live demo on phone, tablet, or another computer</p>
          </div>
        </div>

        {/* Tabs: QR Code vs Direct Link */}
        <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-900/80 rounded-2xl border border-slate-800 mb-4">
          <button
            type="button"
            onClick={() => setActiveTab('qr')}
            className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl font-bold text-xs transition-all cursor-pointer ${
              activeTab === 'qr'
                ? 'bg-[#2DA8A8] text-slate-950 shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
            }`}
          >
            <Smartphone size={15} />
            <span>Scan QR Code</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('url')}
            className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl font-bold text-xs transition-all cursor-pointer ${
              activeTab === 'url'
                ? 'bg-[#2DA8A8] text-slate-950 shadow-md'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
            }`}
          >
            <Monitor size={15} />
            <span>Copy Link for PC</span>
          </button>
        </div>

        {/* Multiple IPs dropdown selector if available */}
        {ips.length > 1 && (
          <div className="mb-3">
            <label className="block text-[11px] font-semibold text-slate-400 mb-1">
              Select Wi-Fi Network Address:
            </label>
            <select
              value={selectedIp || ''}
              onChange={(e) => setSelectedIp(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-white rounded-xl px-3 py-1.5 text-xs font-mono outline-none focus:border-[#2DA8A8]"
            >
              {ips.map((ip) => (
                <option key={ip} value={ip}>
                  {ip} (Wi-Fi / LAN)
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Main Content View */}
        {activeTab === 'qr' ? (
          <div className="my-2 flex flex-col items-center">
            {/* Prominent QR Code Display */}
            <div className="p-4 bg-white rounded-2xl flex flex-col items-center justify-center shadow-lg border border-slate-200 w-full max-w-[280px]">
              <img
                src={qrApiUrl}
                alt="Ziwa Data Local Wi-Fi QR Code"
                className="w-56 h-56 object-contain rounded-lg"
              />
              <div className="mt-2 text-[11px] font-mono font-bold text-[#0A5160] bg-slate-100 px-3 py-1 rounded-full border border-slate-200 text-center break-all">
                {shareUrl}
              </div>
            </div>

            <div className="mt-3 text-center text-xs text-slate-300 bg-slate-900/60 p-3 rounded-xl border border-slate-800/80 w-full">
              <span className="text-[#2DA8A8] font-bold">Instructions:</span> Connect your phone to the same Wi-Fi network and scan the QR code above with your camera.
            </div>
          </div>
        ) : (
          <div className="my-2 space-y-3">
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-2xl">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5 flex items-center justify-between">
                <span>Local Network Address</span>
                <span className="text-[#2DA8A8] flex items-center gap-1 text-[11px]">
                  <Wifi size={12} /> Wi-Fi Ready
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 bg-slate-950 p-3 rounded-xl border border-slate-800 font-mono text-sm font-bold text-[#5ECFE0] break-all select-all">
                <span>{shareUrl}</span>
              </div>
            </div>

            <div className="space-y-2 text-xs text-slate-300 bg-slate-900/60 p-3.5 rounded-2xl border border-slate-800">
              <div className="font-bold text-white mb-1">To open on another PC / Projector:</div>
              <div className="flex items-start gap-2">
                <span className="flex shrink-0 items-center justify-center w-4 h-4 rounded-full bg-[#2DA8A8] text-black font-bold text-[9px]">1</span>
                <span>Connect the target computer to the same Wi-Fi.</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="flex shrink-0 items-center justify-center w-4 h-4 rounded-full bg-[#2DA8A8] text-black font-bold text-[9px]">2</span>
                <span>Copy the URL and open it in Chrome or Edge browser.</span>
              </div>
            </div>
          </div>
        )}

        {/* Footer Action Buttons */}
        <div className="flex gap-2.5 mt-5">
          <button
            type="button"
            onClick={handleCopy}
            className="flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold bg-[#2DA8A8] text-slate-950 hover:bg-[#258E8E] transition-all shadow-lg cursor-pointer"
          >
            {copied ? <Check size={18} /> : <Copy size={18} />}
            <span>{copied ? 'URL Copied!' : 'Copy Wi-Fi URL'}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="py-3 px-4 rounded-xl font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

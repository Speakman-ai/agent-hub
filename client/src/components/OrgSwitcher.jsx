import { useState, useRef, useEffect } from 'react';
import { Building2, ChevronDown, Monitor, Cloud, Check, Settings } from 'lucide-react';
import { getOrgs, getActiveOrg, switchOrg } from '../utils/orgs.js';
import { reloadForOrgSwitch } from '../utils/connection.js';

export default function OrgSwitcher({ onNavigateSettings }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const state = getOrgs();
  const activeOrg = getActiveOrg();

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!activeOrg) return null;

  const orgs = state?.orgs || [];

  const handleSwitch = async (orgId) => {
    if (orgId === activeOrg.id) {
      setOpen(false);
      return;
    }
    await switchOrg(orgId);
    reloadForOrgSwitch();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-1 py-1 rounded-lg hover:bg-gray-800/50 transition-colors group"
      >
        <span
          className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: activeOrg.color }}
        >
          <Building2 size={12} className="text-white" />
        </span>
        <span className="flex-1 text-left truncate text-sm font-semibold text-gray-100">
          {activeOrg.name}
        </span>
        <ChevronDown
          size={14}
          className={`text-gray-500 group-hover:text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="py-1">
            {orgs.map((org) => {
              const isActive = org.id === activeOrg.id;
              return (
                <button
                  key={org.id}
                  onClick={() => handleSwitch(org.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? 'bg-gray-700/50 text-white'
                      : 'text-gray-300 hover:bg-gray-700/30 hover:text-white'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: org.color }}
                  >
                    <Building2 size={10} className="text-white" />
                  </span>
                  <span className="flex-1 text-left truncate">{org.name}</span>
                  <span className="flex items-center gap-1.5 text-xs text-gray-500">
                    {org.mode === 'remote' ? <Cloud size={12} /> : <Monitor size={12} />}
                  </span>
                  {isActive && <Check size={14} className="text-emerald-400 flex-shrink-0" />}
                </button>
              );
            })}
          </div>
          <div className="border-t border-gray-700">
            <button
              onClick={() => {
                setOpen(false);
                onNavigateSettings?.();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700/30 transition-colors"
            >
              <Settings size={12} />
              Manage Organizations
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

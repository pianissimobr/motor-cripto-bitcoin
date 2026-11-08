import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '../session';

const NAV = [
  { to: '/', label: 'Visão geral', icon: '◧', end: true },
  { to: '/pagamentos', label: 'Pagamentos', icon: '⇄' },
  { to: '/links', label: 'Links de pagamento', icon: '⛓' },
  { to: '/carteiras', label: 'Carteiras', icon: '◈' },
  { to: '/integracao', label: 'Integração e API', icon: '⌘' },
  { to: '/configuracoes', label: 'Configurações', icon: '⚙' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { me, merchant, logout } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">LF</span> LibreFlow Pay
        </div>
        <div className="store">
          <span className="store-name">{merchant?.name}</span>
          {merchant?.status !== 'ativo' && <span className="badge badge-bad">Loja inativa</span>}
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setOpen(false)}>
              <span className="nav-icon" aria-hidden>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="muted small">{me?.user.email}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await logout();
              navigate('/entrar', { replace: true });
            }}
          >
            Sair
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-sm menu-toggle" onClick={() => setOpen(!open)} aria-label="Menu">
            ☰
          </button>
          <span className="topbar-note">Painel de gestão: os pagamentos caem direto na sua carteira.</span>
        </header>
        <main className="content">{children}</main>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
    </div>
  );
}

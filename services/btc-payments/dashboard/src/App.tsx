import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Spinner } from './components/ui';
import { ForgotPage, LoginPage, SignupPage, VerifyPage } from './pages/AuthPages';
import { SessionProvider, useSession } from './session';

const OverviewPage = lazy(() => import('./pages/OverviewPage'));
const PaymentsPage = lazy(() => import('./pages/PaymentsPage'));
const PaymentDetailPage = lazy(() => import('./pages/PaymentDetailPage'));
const LinksPage = lazy(() => import('./pages/LinksPage'));
const WalletsPage = lazy(() => import('./pages/WalletsPage'));
const IntegrationPage = lazy(() => import('./pages/IntegrationPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

function Private() {
  const { me, loading } = useSession();
  if (loading) return <div className="center"><Spinner /></div>;
  if (!me) return <Navigate to="/entrar" replace />;
  return (
    <Shell>
      <Suspense fallback={<div className="center"><Spinner /></div>}>
        <Routes>
          <Route index element={<OverviewPage />} />
          <Route path="pagamentos" element={<PaymentsPage />} />
          <Route path="pagamentos/:kind/:id" element={<PaymentDetailPage />} />
          <Route path="links" element={<LinksPage />} />
          <Route path="carteiras" element={<WalletsPage />} />
          <Route path="integracao" element={<IntegrationPage />} />
          <Route path="configuracoes" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

function Public({ children }: { children: JSX.Element }) {
  const { me, loading } = useSession();
  if (loading) return <div className="center"><Spinner /></div>;
  if (me) return <Navigate to="/" replace />;
  return children;
}

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/entrar" element={<Public><LoginPage /></Public>} />
        <Route path="/cadastro" element={<Public><SignupPage /></Public>} />
        <Route path="/confirmar" element={<Public><VerifyPage /></Public>} />
        <Route path="/esqueci" element={<Public><ForgotPage /></Public>} />
        <Route path="/*" element={<Private />} />
      </Routes>
    </SessionProvider>
  );
}

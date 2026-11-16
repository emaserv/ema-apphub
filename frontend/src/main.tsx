import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import '@fontsource/outfit/400.css';
import '@fontsource/outfit/500.css';
import '@fontsource/outfit/600.css';
import '@fontsource/outfit/700.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@xterm/xterm/css/xterm.css';
import './styles/theme.css';
import { AuthProvider, useAuth } from './auth';
import Layout from './components/Layout';
import { Spinner, ToastProvider } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Applications from './pages/Applications';
import NewApplication from './pages/NewApplication';
import ApplicationDetail from './pages/ApplicationDetail';
import Deployments from './pages/Deployments';
import Databases from './pages/Databases';
import Backups from './pages/Backups';
import DockerPage from './pages/DockerPage';
import GitPage from './pages/GitPage';
import UsersPage from './pages/UsersPage';
import AuditPage from './pages/AuditPage';
import SettingsPage from './pages/SettingsPage';

function Protected() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to="/login" replace />;
  return <Layout />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<Protected />}>
              <Route index element={<Dashboard />} />
              <Route path="aplicaciones" element={<Applications />} />
              <Route path="aplicaciones/nueva" element={<NewApplication />} />
              <Route path="aplicaciones/:id" element={<ApplicationDetail />} />
              <Route path="deployments" element={<Deployments />} />
              <Route path="bases-de-datos" element={<Databases />} />
              <Route path="backups" element={<Backups />} />
              <Route path="docker" element={<DockerPage />} />
              <Route path="git" element={<GitPage />} />
              <Route path="usuarios" element={<UsersPage />} />
              <Route path="auditoria" element={<AuditPage />} />
              <Route path="configuracion" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

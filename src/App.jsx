import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import AppLayout from './components/AppLayout';
import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import Wallet from './pages/Wallet';
import ConnectGPU from './pages/ConnectGPU';
import Profile from './pages/Profile';
import GPUFleet from './pages/GPUFleet';
import GPUHealth from './pages/GPUHealth';
import Analytics from './pages/Analytics';
import Simulation from './pages/Simulation';
import RentalAnalytics from './pages/RentalAnalytics';
import PriceAlerts from './pages/PriceAlerts';
import AutoRent from './pages/AutoRent';
import PriceHistory from './pages/PriceHistory';
import ROICalculator from './pages/ROICalculator';
import Admin from './pages/Admin';
import AdminPayouts from './pages/AdminPayouts';
import TreasuryManagement from './pages/TreasuryManagement';
import CreateProfile from './pages/CreateProfile';
import Leaderboard from './pages/Leaderboard';

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      navigateToLogin();
      return null;
    }
  }

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/create-profile" element={<AppLayout><CreateProfile /></AppLayout>} />
      <Route path="/leaderboard" element={<AppLayout><Leaderboard /></AppLayout>} />
      <Route path="/dashboard" element={<AppLayout><Dashboard /></AppLayout>} />
      <Route path="/wallet" element={<AppLayout><Wallet /></AppLayout>} />
      <Route path="/connect" element={<AppLayout><ConnectGPU /></AppLayout>} />
      <Route path="/profile" element={<AppLayout><Profile /></AppLayout>} />
      <Route path="/gpu-fleet" element={<AppLayout><GPUFleet /></AppLayout>} />
      <Route path="/gpu-health" element={<AppLayout><GPUHealth /></AppLayout>} />
      <Route path="/analytics" element={<AppLayout><Analytics /></AppLayout>} />
      <Route path="/simulation" element={<AppLayout><Simulation /></AppLayout>} />
      <Route path="/rental-analytics" element={<AppLayout><RentalAnalytics /></AppLayout>} />
      <Route path="/alerts" element={<AppLayout><PriceAlerts /></AppLayout>} />
      <Route path="/auto-rent" element={<AppLayout><AutoRent /></AppLayout>} />
      <Route path="/price-history" element={<AppLayout><PriceHistory /></AppLayout>} />
      <Route path="/roi-calculator" element={<AppLayout><ROICalculator /></AppLayout>} />
      <Route path="/admin" element={<AppLayout><Admin /></AppLayout>} />
      <Route path="/admin/payouts" element={<AppLayout><AdminPayouts /></AppLayout>} />
      <Route path="/admin/treasury" element={<AppLayout><TreasuryManagement /></AppLayout>} />
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App
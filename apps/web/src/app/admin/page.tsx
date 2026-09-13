'use client';

import React, { useEffect, useState } from 'react';

type Stats = {
  workspaces: number;
  modules: number;
  users: number;
};

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const token = localStorage.getItem('harmoniq_admin_token');
        const res = await fetch(`${process.env.NEXT_PUBLIC_REGISTRY_URL || 'http://localhost:3002'}/api/admin/health`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setStats(data.stats);
        } else {
          setError('Failed to fetch stats. You may not be authenticated as an admin.');
        }
      } catch (err: any) {
        setError(err.message);
      }
    };
    fetchStats();
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Instance Overview</h1>
      {error && <div className="p-4 bg-red-50 text-red-700 rounded-md">{error}</div>}
      
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
            <h3 className="text-sm font-medium text-gray-500">Total Workspaces</h3>
            <p className="mt-2 text-3xl font-bold text-gray-900">{stats.workspaces}</p>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
            <h3 className="text-sm font-medium text-gray-500">Total Modules</h3>
            <p className="mt-2 text-3xl font-bold text-gray-900">{stats.modules}</p>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-100">
            <h3 className="text-sm font-medium text-gray-500">Total Users</h3>
            <p className="mt-2 text-3xl font-bold text-gray-900">{stats.users}</p>
          </div>
        </div>
      )}
    </div>
  );
}

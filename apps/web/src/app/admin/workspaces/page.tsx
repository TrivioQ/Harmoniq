'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

export default function AdminWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchWorkspaces = async () => {
      try {
        const token = localStorage.getItem('harmoniq_admin_token');
        const res = await fetch(`${process.env.NEXT_PUBLIC_REGISTRY_URL || 'http://localhost:3002'}/api/admin/workspaces`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setWorkspaces(data);
        } else {
          setError('Failed to fetch workspaces.');
        }
      } catch (err: any) {
        setError(err.message);
      }
    };
    fetchWorkspaces();
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Workspaces</h1>
      {error && <div className="p-4 bg-red-50 text-red-700 rounded-md">{error}</div>}
      
      <div className="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Slug</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Modules</th>
              <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {workspaces.map((ws) => (
              <tr key={ws.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{ws.name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{ws.slug}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{ws._count?.RemoteModules || 0}</td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <Link href={`/admin/workspaces/${ws.slug}`} className="text-indigo-600 hover:text-indigo-900">
                    Manage Storage
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

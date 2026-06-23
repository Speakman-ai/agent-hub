import React from 'react';
export const SidebarContext = React.createContext({
    openSidebar: () => { },
    closeSidebar: () => { },
    toggleSidebar: () => { },
});

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import Chart from 'chart.js/auto';

declare var PptxGenJS: any;

// --- TYPE DEFINITIONS ---
interface GraphData {
    labels: string[];
    values: number[];
}

interface StandardTableData {
    rows: { timeRange: string; columns: string[] }[];
}

interface PivotTableData {
    headers: string[];
    rows: string[][];
}

interface ItemData {
    graphs: { [graphName: string]: GraphData };
    standardTables: { [tableName: string]: StandardTableData };
    pivotTables: { [tableName: string]: PivotTableData };
}

interface ProcessedResults {
    [itemName: string]: ItemData;
}

interface ApiResponse {
    status: 'running' | 'completed' | 'error';
    message: string | null;
    results: { resumen: string } | null;
}

// --- API CONFIG ---
const POLLING_INTERVAL = 5000; // 5 seconds

// --- HELPERS ---
const getInitialStartDate = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}T00:00`;
};

const getInitialEndDate = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:00`;
};


// --- DATA PARSER ---
const parseAndOrganizeData = (rawData: string): ProcessedResults => {
    const processed: ProcessedResults = {};
    const rawLines = rawData.split('\n').filter(line => line.trim() !== '');

    const getSortableHour = (timeRangeString: string): number => {
        if (!timeRangeString) return 0;
        const hour = parseInt(timeRangeString.split(':')[0], 10);
        return hour < 6 ? hour + 24 : hour;
    };
    
    // Temporary structure for raw table data
    const rawTableData: {
        [itemName: string]: {
            [tableName: string]: {
                keyIndex: number;
                rows: { timeRange: string; columns: string[] }[];
            }
        }
    } = {};

    rawLines.forEach(line => {
        const parts = line.split(';');
        if (parts.length < 5) return;

        const [timeRange, itemName, dataType] = parts;

        const initializeItem = (itemName: string) => {
            if (!processed[itemName]) {
                processed[itemName] = { graphs: {}, standardTables: {}, pivotTables: {} };
            }
        };
        
        initializeItem(itemName);

        if (dataType === 'numero' && parts.length === 5) {
            const [, , , dataName, valueStr] = parts;
            const value = parseFloat(valueStr);
            if (!isNaN(value)) {
                if (!processed[itemName].graphs[dataName]) {
                    processed[itemName].graphs[dataName] = { labels: [], values: [] };
                }
                const tempData = processed[itemName].graphs[dataName] as any;
                if (!tempData.tuples) tempData.tuples = [];
                tempData.tuples.push({ timeRange, value });
            }
        } else if (dataType === 'tabla' && parts.length >= 6) {
            const [, , , tableName, keyIndexStr, ...columns] = parts;
            const keyIndex = parseInt(keyIndexStr, 10);

            if (isNaN(keyIndex) || keyIndex < 1) return;

            if (!rawTableData[itemName]) rawTableData[itemName] = {};
            if (!rawTableData[itemName][tableName]) {
                rawTableData[itemName][tableName] = { keyIndex, rows: [] };
            }
            
            rawTableData[itemName][tableName].rows.push({ timeRange, columns });
        }
    });

    // --- PIVOTING LOGIC ---
    for (const itemName in rawTableData) {
        for (const tableName in rawTableData[itemName]) {
            const tableData = rawTableData[itemName][tableName];
            const { keyIndex, rows } = tableData;

            if (rows.length === 0) continue;
            
            // 1-based to 0-based index
            const groupingColumnIndex = keyIndex - 1;
            const valueColumnIndex = rows[0].columns.length - 1;

            if (groupingColumnIndex >= valueColumnIndex || groupingColumnIndex < 0) continue;

            // 1. Aggregate data by grouping key
            const aggregatedData = new Map<string, {
                otherKeyColumns: string[];
                total: number;
                timeData: Map<string, number>;
            }>();
            
            const allTimeRanges = new Set<string>();

            rows.forEach(row => {
                allTimeRanges.add(row.timeRange);
                const groupingValue = row.columns[groupingColumnIndex];
                const valueStr = row.columns[valueColumnIndex];
                const value = parseFloat(valueStr) || 0;

                const otherKeyColumns = row.columns.filter((_, idx) => idx !== groupingColumnIndex && idx !== valueColumnIndex);

                if (!aggregatedData.has(groupingValue)) {
                    aggregatedData.set(groupingValue, {
                        otherKeyColumns, // Assume these are consistent for the same key
                        total: 0,
                        timeData: new Map()
                    });
                }

                const entry = aggregatedData.get(groupingValue)!;
                entry.total += value;
                entry.timeData.set(row.timeRange, (entry.timeData.get(row.timeRange) || 0) + value);
            });

            // 2. Determine sorted time ranges and create headers
            const sortedTimeRanges = Array.from(allTimeRanges).sort((a, b) => getSortableHour(a) - getSortableHour(b));
            
            const numTextColumns = valueColumnIndex;
            const textColumnHeaders = Array.from({ length: numTextColumns }, (_, i) => `Column ${i + 1}`);
            const finalHeaders = [...textColumnHeaders, 'Total', ...sortedTimeRanges];

            // 3. Build the pivoted rows
            const pivotedRows: string[][] = [];
            for (const [groupingValue, data] of aggregatedData.entries()) {
                const textColumns: (string|number)[] = [];
                let otherKeyColumnIndex = 0;
                for (let i = 0; i < numTextColumns; i++) {
                    if (i === groupingColumnIndex) {
                        textColumns.push(groupingValue);
                    } else {
                        textColumns.push(data.otherKeyColumns[otherKeyColumnIndex++] || '');
                    }
                }
                
                const newRow = [
                    ...textColumns,
                    data.total,
                    ...sortedTimeRanges.map(tr => data.timeData.get(tr) || 0)
                ];
                
                pivotedRows.push(newRow.map(String));
            }
            
            if (!processed[itemName].pivotTables) processed[itemName].pivotTables = {};
            processed[itemName].pivotTables[tableName] = {
                headers: finalHeaders,
                rows: pivotedRows
            };
        }
    }
    
    // Post-processing: Sort graph data
    for (const item in processed) {
        for (const graphName in processed[item].graphs) {
            const graphData = processed[item].graphs[graphName] as any;
            if (graphData.tuples) {
                graphData.tuples.sort((a: any, b: any) => getSortableHour(a.timeRange) - getSortableHour(b.timeRange));
                processed[item].graphs[graphName].labels = graphData.tuples.map((t: any) => t.timeRange);
                processed[item].graphs[graphName].values = graphData.tuples.map((t: any) => t.value);
                delete graphData.tuples;
            }
        }
    }

    return processed;
};


// --- Modal Component ---
type ModalProps = {
    children?: React.ReactNode;
    onClose: () => void;
    className?: string;
    show: boolean;
};

const Modal = ({ children, onClose, className = '', show }: ModalProps) => {
    useEffect(() => {
        const handleEsc = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handleEsc);
        return () => window.removeEventListener('keydown', handleEsc);
    }, [onClose]);

    if (!show) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className={`modal-content ${className}`} onClick={(e) => e.stopPropagation()}>
                <button className="modal-close" onClick={onClose} aria-label="Close modal">&times;</button>
                {children}
            </div>
        </div>
    );
};

// --- Chart Component ---
interface ChartComponentProps {
    chartData: {
        labels: string[];
        values: (number | string)[];
    };
    chartType: 'bar' | 'line';
    chartLabel: string;
    setCanvasRef: (canvas: HTMLCanvasElement | null) => void;
    isZoomed?: boolean;
}

const ChartComponent = ({ chartData, chartType, chartLabel, setCanvasRef, isZoomed = false }: ChartComponentProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const chartRef = useRef<Chart | null>(null);

    useEffect(() => {
        if (canvasRef.current && chartData) {
            const ctx = canvasRef.current.getContext('2d');
            if (!ctx) return;
            
            setCanvasRef(canvasRef.current);

            if (chartRef.current) {
                chartRef.current.destroy();
            }

            const gradient = ctx.createLinearGradient(0, 0, 0, 400);
            gradient.addColorStop(0, 'rgba(236, 0, 0, 0.5)');
            gradient.addColorStop(1, 'rgba(236, 0, 0, 0)');
            
            const isDarkMode = document.body.classList.contains('dark');
            const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
            const textColor = isDarkMode ? '#f4f4f4' : '#333';
            
            const numericValues = chartData.values.map(Number);

            let datasetOptions;
            if (chartType === 'line') {
                datasetOptions = {
                    label: chartLabel,
                    data: numericValues,
                    borderColor: 'rgba(236, 0, 0, 1)',
                    backgroundColor: 'rgba(236, 0, 0, 0.1)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4,
                    pointBackgroundColor: 'rgba(236, 0, 0, 1)',
                    pointBorderColor: '#fff',
                    pointHoverRadius: 7
                };
            } else { // bar
                datasetOptions = {
                    label: chartLabel,
                    data: numericValues,
                    backgroundColor: gradient,
                    borderColor: 'rgba(236, 0, 0, 1)',
                    borderWidth: 1,
                };
            }
            
            chartRef.current = new Chart(ctx, {
                type: chartType,
                data: {
                    labels: chartData.labels,
                    datasets: [datasetOptions]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 1000 },
                    interaction: {
                        intersect: false,
                        mode: 'index',
                    },
                    plugins: {
                        legend: { position: 'top', labels: { color: textColor, font: { size: isZoomed ? 16 : 12 } } },
                        title: { display: false },
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: { color: gridColor },
                            ticks: { color: textColor, font: {size: isZoomed ? 14: 10} }
                        },
                        x: {
                            grid: { display: false },
                            ticks: { color: textColor, font: {size: isZoomed ? 14: 10} }
                        }
                    }
                },
            });
        }
        return () => {
             if (chartRef.current) chartRef.current.destroy();
             setCanvasRef(null);
        };
    }, [chartData, chartType, chartLabel, isZoomed]);

    return <div className="chart-container-inner" style={{ height: isZoomed ? '100%' : '300px' }}><canvas ref={canvasRef}></canvas></div>;
};


// --- Main App Component ---
const App = () => {
    const [apiUrl, setApiUrl] = useState('http://127.0.0.1:5000');
    const [startDate, setStartDate] = useState(getInitialStartDate);
    const [endDate, setEndDate] = useState(getInitialEndDate);
    const [interval, setInterval] = useState('60');
    
    const [status, setStatus] = useState<'idle' | 'pending' | 'polling' | 'completed' | 'error'>('idle');
    const [statusMessage, setStatusMessage] = useState('');
    const [processedData, setProcessedData] = useState<ProcessedResults | null>(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [connectionStatus, setConnectionStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
    const [rawResponse, setRawResponse] = useState<string>('');
    const [theme, setTheme] = useState('light');
    
    const [isRawModalOpen, setRawModalOpen] = useState(false);
    const [zoomedChart, setZoomedChart] = useState<{ name: string; type: 'bar' | 'line'; data: GraphData } | null>(null);
    const [isZoomModalVisible, setIsZoomModalVisible] = useState(false);

    const [availableTabs, setAvailableTabs] = useState<string[]>([]);
    const [activeTab, setActiveTab] = useState<string | null>(null);

    const pollingRef = useRef<number | null>(null);
    const chartCanvasRefs = useRef<{ [key: string]: HTMLCanvasElement | null }>({});
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        document.body.className = theme;
    }, [theme]);
    
    useEffect(() => {
        if (status === 'completed' && processedData) {
            const newTabs = Object.keys(processedData);
            setAvailableTabs(newTabs);
    
            if (newTabs.length > 0) {
                setActiveTab(current => current && newTabs.includes(current) ? current : newTabs[0]);
            } else {
                setActiveTab(null);
            }
        } else if (status !== 'completed') {
            setActiveTab(null);
            setAvailableTabs([]);
            setProcessedData(null);
        }
    }, [status, processedData]);


    const toggleTheme = () => {
        setTheme(prev => prev === 'dark' ? 'light' : 'dark');
    };

    const handleZoomOpen = (name: string, data: GraphData, type: 'bar' | 'line') => {
        setZoomedChart({ name, data, type });
        setTimeout(() => setIsZoomModalVisible(true), 50);
    };

    const handleZoomClose = () => {
        setIsZoomModalVisible(false);
        setTimeout(() => {
            setZoomedChart(null);
        }, 400); 
    };

    const stopPolling = () => {
        if (pollingRef.current) {
            window.clearInterval(pollingRef.current);
            pollingRef.current = null;
        }
    };
    
    const fetchStatus = useCallback(async () => {
        try {
            const response = await fetch(`${apiUrl}/status`);
            if (!response.ok) throw new Error(`API error: ${response.statusText}`);
            
            const rawText = await response.text();
            setRawResponse(rawText);
            const data: ApiResponse = JSON.parse(rawText);

            setStatusMessage(data.message || 'Processing data...');

            if (data.status === 'completed') {
                setStatus('completed');
                let parsedResults: ProcessedResults | null = null;
                const resultsData = data.results;

                if (resultsData && typeof resultsData.resumen === 'string') {
                    parsedResults = parseAndOrganizeData(resultsData.resumen);
                } else {
                     console.warn("Received completed status but results.resumen is not a string.", data.results);
                }
                setProcessedData(parsedResults);
                stopPolling();
            } else if (data.status === 'error') {
                setStatus('error');
                setErrorMessage(data.message || 'An unknown error occurred.');
                stopPolling();
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Failed to connect to the server.';
            setErrorMessage(error instanceof SyntaxError ? `Failed to parse server response. Error: ${msg}` : msg);
            setStatus('error');
            stopPolling();
        }
    }, [apiUrl]);

    const checkConnection = useCallback(async (url: string) => {
        try {
            const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(3000) });
            setConnectionStatus(response.ok ? 'connected' : 'disconnected');
        } catch (error) {
            setConnectionStatus('disconnected');
        }
    }, []);

    useEffect(() => {
        if (!apiUrl) return;
        setConnectionStatus('checking');
        const handler = setTimeout(() => checkConnection(apiUrl), 500);
        return () => clearTimeout(handler);
    }, [apiUrl, checkConnection]);

    const handleStartMonitoring = async (e: React.FormEvent) => {
        e.preventDefault();
        stopPolling();
        setProcessedData(null);
        setErrorMessage('');
        setRawResponse('');
        setRawModalOpen(false);
        setZoomedChart(null);
        chartCanvasRefs.current = {};
        setStatus('pending');
        setStatusMessage('Initializing monitoring process...');

        try {
            const response = await fetch(`${apiUrl}/monitor`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    start_date: `${startDate}:00`,
                    end_date: `${endDate}:00`,
                    interval
                })
            });

            if (response.status !== 202) throw new Error(`Failed to start. Server responded with ${response.status}`);
            
            const data = await response.json();
            if (data.status === 'monitoring_started') {
                setStatus('polling');
                setStatusMessage('Monitoring started. Waiting for data...');
                pollingRef.current = window.setInterval(fetchStatus, POLLING_INTERVAL);
            } else {
                throw new Error('Unexpected response from server on start.');
            }
        } catch (error) {
            setStatus('error');
            setErrorMessage(error instanceof Error ? error.message : 'Failed to connect to the server.');
        }
    };

    const handleExport = () => {
        if (!processedData) return;
        const pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_WIDE';
        const titleSlide = pptx.addSlide();
        titleSlide.addText('Monitoring Online Report', { x: 0.5, y: 1, fontSize: 32, bold: true, color: 'EC0000' });
        const date = new Date().toLocaleDateString();
        titleSlide.addText(`Generated on: ${date}`, { x: 0.5, y: 1.8, fontSize: 18 });

        const chartsByItem: { [itemName: string]: { [graphName: string]: { bar?: HTMLCanvasElement, line?: HTMLCanvasElement } } } = {};

        Object.entries(chartCanvasRefs.current).forEach(([key, canvas]) => {
            if (canvas instanceof HTMLCanvasElement) {
                const [itemName, graphName, chartType] = key.split('-');
                if (!chartsByItem[itemName]) chartsByItem[itemName] = {};
                if (!chartsByItem[itemName][graphName]) chartsByItem[itemName][graphName] = {};
                
                if (chartType === 'bar') {
                    chartsByItem[itemName][graphName].bar = canvas;
                } else if (chartType === 'line') {
                    chartsByItem[itemName][graphName].line = canvas;
                }
            }
        });

        Object.entries(chartsByItem).forEach(([itemName, graphs]) => {
            Object.entries(graphs).forEach(([graphName, canvases]) => {
                 const slide = pptx.addSlide();
                 slide.addText(`${itemName} - ${graphName}`, { x: 0.5, y: 0.2, w: '90%', h: 0.5, fontSize: 24, bold: true, color: 'EC0000' });

                if (canvases.bar) {
                    slide.addText('Por Hora (Individual)', { x: 0.5, y: 0.8, w: '45%', h: 0.4, fontSize: 16 });
                    const barDataUrl = canvases.bar.toDataURL('image/png');
                    slide.addImage({ data: barDataUrl, x: 0.5, y: 1.3, w: 6.0, h: 4.0 });
                }

                if (canvases.line) {
                    slide.addText('Acumulado', { x: 6.83, y: 0.8, w: '45%', h: 0.4, fontSize: 16 });
                    const lineDataUrl = canvases.line.toDataURL('image/png');
                    slide.addImage({ data: lineDataUrl, x: 6.83, y: 1.3, w: 6.0, h: 4.0 });
                }
            });
        });
        
        Object.entries(processedData).forEach(([itemName, itemData]: [string, ItemData]) => {
            if (itemData.standardTables && Object.keys(itemData.standardTables).length > 0) {
                 const slide = pptx.addSlide();
                 slide.addText(`Standard Tables: ${itemName}`, { x: 0.5, y: 0.25, fontSize: 24, bold: true });
                 
                 const tableData: (string[])[] = [];
                 const allRows = Object.entries(itemData.standardTables).flatMap(([tableName, data]) => 
                     data.rows.map(row => ({ tableName, ...row }))
                 );
                 const maxCols = Math.max(0, ...allRows.map(r => r.columns.length));
                 const headers = ["Table", "Time Range", ...Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`)];
                 tableData.push(headers);

                 allRows.forEach(row => {
                    const paddedCols = [...row.columns, ...Array(maxCols - row.columns.length).fill('')];
                    tableData.push([row.tableName, row.timeRange, ...paddedCols]);
                 });

                 slide.addTable(tableData, { 
                     x: 0.5, y: 1.0, w: 12.33,
                     border: { type: 'solid', pt: 1, color: '666666' },
                     autoPage: true,
                     newSlideStartY: 1.0,
                     head_opts: { background: 'EC0000', color: 'FFFFFF', bold: true }
                 });
            }
            if (itemData.pivotTables && Object.keys(itemData.pivotTables).length > 0) {
                Object.entries(itemData.pivotTables).forEach(([tableName, pivotData]) => {
                    const slide = pptx.addSlide();
                    slide.addText(`Pivot Table: ${itemName} - ${tableName}`, { x: 0.5, y: 0.25, fontSize: 24, bold: true });
                    
                    const tableData = [pivotData.headers, ...pivotData.rows];
                    
                    slide.addTable(tableData, {
                         x: 0.5, y: 1.0, w: 12.33,
                         border: { type: 'solid', pt: 1, color: '666666' },
                         autoPage: true,
                         newSlideStartY: 1.0,
                         head_opts: { background: 'EC0000', color: 'FFFFFF', bold: true }
                    });
                });
            }
        });

        pptx.writeFile({ fileName: `Monitoring_Report_${Date.now()}.pptx` });
    };

    const handleJsonExport = () => {
        if (!processedData) return;
        const dataStr = JSON.stringify(processedData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `Monitoring_Report_data_${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const handleLoadReportClick = () => {
        fileInputRef.current?.click();
    };

    const handleJsonFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target?.result;
                if (typeof text !== 'string') throw new Error("File content is not readable.");
                const data = JSON.parse(text);
                if (typeof data !== 'object' || data === null || Object.keys(data).length === 0) {
                    throw new Error("Invalid or empty JSON file.");
                }
                stopPolling();
                setProcessedData(data);
                setStatus('completed');
                setErrorMessage('');
                setRawResponse(JSON.stringify({
                    status: 'completed',
                    message: 'Loaded from file.',
                    results: { resumen: 'Data loaded from local JSON file.' }
                }, null, 2));
            } catch (error) {
                setStatus('error');
                setErrorMessage(error instanceof Error ? `Failed to load report: ${error.message}` : 'An unknown error occurred while loading the report.');
                setProcessedData(null);
            } finally {
                if (event.target) event.target.value = '';
            }
        };
        reader.onerror = () => {
            setStatus('error');
            setErrorMessage('Failed to read the file.');
            setProcessedData(null);
        };
        reader.readAsText(file);
    };
    
    const getButtonState = () => {
        const connected = connectionStatus === 'connected';
        if (!connected) return { disabled: true, text: 'Start Monitoring' };
        if (status === 'pending' || status === 'polling') return { disabled: true, text: 'Monitoring...' };
        return { disabled: false, text: 'Start Monitoring' };
    };

    const renderContent = () => {
        switch (status) {
            case 'pending':
            case 'polling':
                return <div className="card status-container"><div className="spinner"></div><p>{statusMessage}</p></div>;
            case 'completed':
                if (!processedData) return <div className="card error-container">Completed, but no results found.</div>;
                if (availableTabs.length === 0) return <div className="card">No data available for the selected period.</div>;
                
                const currentTabData: ItemData | null = activeTab ? processedData[activeTab] : null;
                const hasGraphs = currentTabData && Object.keys(currentTabData.graphs).length > 0;
                const hasStandardTables = currentTabData && Object.keys(currentTabData.standardTables).length > 0;
                const hasPivotTables = currentTabData && Object.keys(currentTabData.pivotTables).length > 0;

                return (
                    <div className="results-container">
                        <nav className="tabs-container" role="tablist">
                            {availableTabs.map(tabName => (
                                <button
                                    key={tabName}
                                    className={`tab-btn ${activeTab === tabName ? 'active' : ''}`}
                                    onClick={() => setActiveTab(tabName)}
                                    role="tab"
                                    aria-selected={activeTab === tabName}
                                >
                                    {tabName}
                                </button>
                            ))}
                        </nav>

                        <div className="tab-content" key={activeTab}>
                           {currentTabData && (
                            <>
                                {hasGraphs && (
                                    <div className="card report-section">
                                        <h2 className="section-title">Graphs</h2>
                                        <div className="charts-grid">
                                            {Object.entries(currentTabData.graphs).map(([graphName, graphData]) => {
                                                const cumulativeValues: number[] = [];
                                                graphData.values.reduce((acc, val) => {
                                                    const newTotal = acc + val;
                                                    cumulativeValues.push(newTotal);
                                                    return newTotal;
                                                }, 0);

                                                return (
                                                    <div className="module-container" key={graphName}>
                                                        <h3 className="module-title">{graphName}</h3>
                                                        <div className="charts-pair">
                                                            <div className="chart-wrapper">
                                                                <h4 className="chart-title">Por Hora (Individual)</h4>
                                                                <button className="icon-btn zoom-btn" onClick={() => handleZoomOpen(graphName, graphData, 'bar')} aria-label={`Zoom chart ${graphName} Por Hora`}>
                                                                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                                                                </button>
                                                                <ChartComponent 
                                                                    chartType="bar"
                                                                    chartLabel="Por Hora"
                                                                    chartData={{ labels: graphData.labels, values: graphData.values }}
                                                                    setCanvasRef={(canvas) => { if(activeTab) chartCanvasRefs.current[`${activeTab}-${graphName}-bar`] = canvas; }}
                                                                />
                                                            </div>
                                                            <div className="chart-wrapper">
                                                                <h4 className="chart-title">Acumulado</h4>
                                                                <button className="icon-btn zoom-btn" onClick={() => handleZoomOpen(graphName, {labels: graphData.labels, values: cumulativeValues}, 'line')} aria-label={`Zoom chart ${graphName} Acumulado`}>
                                                                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
                                                                </button>
                                                                <ChartComponent 
                                                                    chartType="line"
                                                                    chartLabel="Acumulado"
                                                                    chartData={{ labels: graphData.labels, values: cumulativeValues }}
                                                                    setCanvasRef={(canvas) => { if(activeTab) chartCanvasRefs.current[`${activeTab}-${graphName}-line`] = canvas; }}
                                                                />
                                                            </div>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </div>
                                )}
                                {hasStandardTables && (
                                     <div className="card report-section">
                                        <h2 className="section-title">Standard Tables</h2>
                                        {Object.entries(currentTabData.standardTables).map(([tableName, tableData]) => {
                                            const maxCols = Math.max(0, ...tableData.rows.map(r => r.columns.length));
                                            const headers = ['Rango Horario', ...Array.from({ length: maxCols }, (_, i) => `Columna ${i + 1}`)];
                                            return (
                                                <div className="table-wrapper" key={tableName}>
                                                    <h3>{tableName}</h3>
                                                    <table>
                                                        <thead>
                                                            <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                                                        </thead>
                                                        <tbody>
                                                            {tableData.rows.map((row, index) => (
                                                                <tr key={index}>
                                                                    <td>{row.timeRange}</td>
                                                                    {row.columns.map((col, cIndex) => <td key={cIndex}>{col}</td>)}
                                                                    {Array.from({ length: maxCols - row.columns.length }).map((_, padIndex) => <td key={`pad-${padIndex}`}></td>)}
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                                {hasPivotTables && (
                                     <div className="card report-section">
                                        <h2 className="section-title">Tables</h2>
                                        {Object.entries(currentTabData.pivotTables).map(([tableName, pivotData]) => (
                                            <div className="table-wrapper" key={tableName}>
                                                <h3>{tableName}</h3>
                                                <table>
                                                    <thead>
                                                        <tr>{pivotData.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                                                    </thead>
                                                    <tbody>
                                                        {pivotData.rows.map((row, index) => (
                                                            <tr key={index}>
                                                                {row.map((cell, cIndex) => <td key={cIndex}>{cell}</td>)}
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                           )}
                        </div>
                    </div>
                );
            case 'error': return <div className="card error-container">{errorMessage}</div>;
            default: return null;
        }
    }

    return (
        <main>
            <header className="header"><h1 className="app-title">Monitoring Online</h1><p className="app-subtitle">Robot</p></header>
            <section className="card form-container" aria-labelledby="form-heading">
                <h2 id="form-heading" className="sr-only">Configure Monitoring Period</h2>
                <form onSubmit={handleStartMonitoring}>
                    <div className="form-grid">
                        <div className="form-group"><label htmlFor="start-date">Start Date & Time</label><input type="datetime-local" id="start-date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required /></div>
                        <div className="form-group"><label htmlFor="end-date">End Date & Time</label><input type="datetime-local" id="end-date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required /></div>
                        <div className="form-group"><label htmlFor="interval">Interval (minutes)</label><input type="number" id="interval" value={interval} onChange={(e) => setInterval(e.target.value)} min="1" required /></div>
                        <div className="form-actions">
                            <button type="submit" className="submit-btn" disabled={getButtonState().disabled}>{getButtonState().text}</button>
                        </div>
                    </div>
                </form>
                <input type="file" ref={fileInputRef} onChange={handleJsonFileChange} accept=".json" style={{ display: 'none' }} aria-hidden="true" />
            </section>
            
            {renderContent()}

            <div className="floating-bar">
                 <div className="api-input-group">
                    <div className="connection-status-container">
                        <div className={`status-indicator ${connectionStatus}`}></div>
                        <span>API Status</span>
                    </div>
                    <input type="text" id="api-url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} required placeholder="API URL" />
                </div>
                <div className="fab-buttons">
                     <button className="icon-btn" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
                        {theme === 'dark' ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
                        )}
                    </button>
                    <button className="icon-btn" onClick={handleExport} disabled={!processedData} aria-label="Export to PowerPoint">
                         <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256"><path fill="currentColor" d="M48 21.333V234.667c0 7.36 5.973 13.333 13.333 13.333h133.334c7.36 0 13.333-5.973 13.333-13.333v-96L142.667 80H61.333C53.973 80 48 74.027 48 66.667V21.333z"/><path fill="currentColor" d="M149.333 21.333v58.667c0 7.36 5.973 13.333 13.333 13.333h53.334z"/><path fill="#FFF" d="M128 117.333c-23.52 0-42.667 19.147-42.667 42.667s19.147 42.667 42.667 42.667 42.667-19.147 42.667-42.667-19.147-42.667-42.667-42.667zm0 64c-11.733 0-21.333-9.6-21.333-21.333S116.267 138.667 128 138.667s21.333 9.6 21.333 21.333S139.733 181.333 128 181.333z"/><path fill="#FFF" d="M101.333 149.333a5.333 5.333 0 0 0-5.333 5.333v2.667c0 8.853 7.147 16 16 16h8c2.947 0 5.333-2.387 5.333-5.333s-2.387-5.333-5.333-5.333h-8c-3.52 0-6.667-2.827-6.667-6.347v-1.653a5.333 5.333 0 0 0-5.333-5.333z"/></svg>
                    </button>
                    <button className="icon-btn" onClick={handleLoadReportClick} disabled={status === 'pending' || status === 'polling'} aria-label="Load JSON Report">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    </button>
                    <button className="icon-btn" onClick={handleJsonExport} disabled={!processedData} aria-label="Download JSON Report">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                    <button className="icon-btn" onClick={() => setRawModalOpen(true)} disabled={!rawResponse} aria-label="Show raw API response">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                    </button>
                </div>
            </div>
            
            <Modal show={isRawModalOpen} onClose={() => setRawModalOpen(false)}>
                <h2 className="section-title">Raw API Response</h2>
                <pre className="raw-response-content"><code>{JSON.stringify(JSON.parse(rawResponse || '{}'), null, 2)}</code></pre>
            </Modal>

            <Modal show={!!zoomedChart} onClose={handleZoomClose} className={`zoomed-chart-modal ${isZoomModalVisible ? 'visible' : ''}`}>
                {zoomedChart && (
                     <ChartComponent 
                        chartData={{
                            labels: zoomedChart.data.labels,
                            values: zoomedChart.type === 'bar' 
                                ? zoomedChart.data.values
                                : zoomedChart.data.values
                        }}
                        chartType={zoomedChart.type}
                        chartLabel={zoomedChart.type === 'bar' ? 'Por Hora' : 'Acumulado'}
                        setCanvasRef={()=>{}} 
                        isZoomed={true} 
                    />
                )}
            </Modal>

            <footer className="footer">
                <div className="logo">
                    <div className="flame"></div>
                    <span>Santander</span>
                </div>
            </footer>
        </main>
    );
};

const container = document.getElementById('root');
if (container) {
    createRoot(container).render(<App />);
}
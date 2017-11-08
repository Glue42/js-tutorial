const RestServerUrl = 'http://localhost:22910/';
const RestServerEndpoint = 'GetDemoPortfolio';
const StreamName = 'T42.MarketStream.Subscribe';
let inActivity;

let detachedTabs = [];
let streams = [];
let _query;
let partyObj;

let serviceMetricsSystem;
let serviceErrorCount;
let lastServiceError;
let serviceLatency;
let logger;

Glue(glueConfig)
    .then((glue) => {
        window.glue = glue;

        const glue4OfficeOptions = {
            glue: glue,
            outlook: true,
            excel: true
        };

        return Glue4Office(glue4OfficeOptions);
    })
    .then((g4o) => {
        window.outlook = g4o.outlook;
        window.excel = g4o.excel;

        inActivity = glue.activities.inActivity;
        instrumentService();
        onInitializeApp();
        initInstrumentSearch();
        trackTheme();

    })
    .catch((error) => {
        console.error(error);
    })

const instrumentService = () => {
    logger = glue.logger.subLogger('PortfolioWindow');

    const metrics = glue.metrics;

    serviceMetricsSystem = metrics.subSystem('PortfolioService', 'Portfolio REST Service');

    serviceMetricsSystem.setState(0, 'OK');

    const errorCountOptions = {
        name: 'errorCount',
        description: 'number of times AJAX requests have failed'
    };

    serviceErrorCount = serviceMetricsSystem.countMetric(errorCountOptions, 0);

    const serviceErrorOptions = {
        name: 'lastError',
        description: 'Last recorded service error'
    };

    const serviceErrorTemplate = {
        // the first value defines
        // the shape of the metric
        clientId: '',
        message: '',
        time: new Date(),
        stackTrace: ''
    };

    lastServiceError = serviceMetricsSystem.objectMetric(serviceErrorOptions, serviceErrorTemplate);

    const latencyOptions = {
        name: 'latency',
        description: 'Request latency'
    };

    serviceLatency = serviceMetricsSystem.timespanMetric(latencyOptions);
};

const onInitializeApp = () => {

    setUpAppContent();
    setUpStreamIndicator();
    setUpGlueIndicator();
    setUpWindowEventsListeners();
    setUpTabControls();
};

const initInstrumentSearch = () => {

    const initClientSearch = (agm) => {
        const gssOptions = {
            agm: agm,
            defaultQueryLimit: 500,
            measureLatency: false,
            searchTimeoutInMillis: 10000,
            debugGss: false,
            debug: false
        };

        return new gssClientSearch.create(gssOptions);
    }


    const createQuery = (clientSearch) => {
        _query = clientSearch.createQuery('Instrument')

        _query.onEntityTypeBound(function () {
            console.log('onEntityTypeBound');
        });
        _query.onEntityTypeUnbound(function () {
            console.log('onEntityTypeUnbound');
        });

        _query.onData(function (entities, isFromCache) {
            console.log(entities);
            displayResult(entities)
        });

        _query.onDone(function () {
            console.log('query is done');
        });

        _query.onError(function (error) {
            console.log(error);
        });
    }

    createQuery(initClientSearch(glue.agm));
};

const trackTheme = () => {
    const setTheme = (name) => {
        $('#themeLink').attr('href', '../lib/themes/css/' + name);
    }

    glue.contexts.subscribe('theme', (context) => {
        if (context.name === 'dark') {
            setTheme('bootstrap-dark.min.css');
        } else if (context.name === 'light') {
            setTheme('bootstrap.min.css');
        }
    });
};

const setUpAppContent = () => {

    const context = glue.windows.my().context;

    if (!context.party) {
        registerAgmMethod();

    } else {
        const title = 'Portfolio of ' + context.party.preferredName;

        glue.windows.my().setTitle(title)

        document.getElementById('title').textContent = title;

        loadPortfolio(context.party.eciId);

        partyObj = context.party;
    }
};

const registerAgmMethod = () => {
    if (inActivity) {
        glue.activities.my.activity.onContextChanged((context) => {
            partyObj = context.party

            loadPortfolio(context.party.eciId)

        });
    } else {
        glue.agm.register({
            name: 'SetParty',
            accepts: 'Composite: {string? eciId, string? ucn} party',
            object_types: ['Party']
        }, (args) => {
            partyObj = args.party;

            loadPortfolio(partyObj.eciId);

        });
    }
};

const loadPortfolio = (eci) => {
    const serviceUrl = RestServerUrl + RestServerEndpoint;

    const serviceRequest = 'xpath=//Portfolios/Portfolio[id=' + eci + ']';

    const requestStart = Date.now();

    serviceLatency.start();

    const ajaxOptions = {
        method: 'GET',
        url: serviceUrl,
        data: serviceRequest
    };

    $.ajax(ajaxOptions)
        .done((portfolio) => {
            serviceLatency.stop();

            const elapsedMillis = Date.now() - requestStart;

            if (elapsedMillis >= 1000) {
                const message = 'Service at ' + serviceUrl + ' is lagging';

                logger.warn(message);

                serviceMetricsSystem.setState(50, message);

            } else {
                serviceMetricsSystem.setState(0, 'OK');

            }

            let parsedPortfolio;
            if (typeof portfolio !== 'undefined') {
                parsedPortfolio = JSON.parse(portfolio);
            }

            logger.info({ portfolioId: eci, portfolio: parsedPortfolio });

            if (!parsedPortfolio.Portfolios.hasOwnProperty('Portfolio')) {
                console.warn('The client has no portfolio')
                return;
            }

            setupPortfolio(parsedPortfolio.Portfolios.Portfolio.Symbols.Symbol);
            unsubscribeSymbolPrices();
            subscribeSymbolPrices();
        })
        .fail(function (jqXHR, textStatus) {

            serviceLatency.stop();

            serviceErrorCount.increment();

            const errorMessage = 'Service at ' + serviceUrl + ' failed at ' + serviceRequest + ' with ' + textStatus;

            const errorOptions = {
                clientId: eci,
                message: errorMessage,
                time: new Date(),
                stackTrace: ''
            };

            lastServiceError.update(errorOptions);

            serviceMetricsSystem.setState(100, errorMessage);

            logger.error(errorMessage);
        })
}

const subscribeSymbolPrices = () => {
    const trs = document.querySelectorAll('#portfolioTableData tr');

    trs.forEach((tr) => {
        const symbol = tr.getAttribute('id');

        subscribeBySymbol(symbol, updateInstruments)
    })
}

const unsubscribeSymbolPrices = () => {
    streams.forEach((stream) => {
        console.log('Closing stream with', stream);

        stream.close();
    });
}

const subscribeBySymbol = (symbol, callback) => {

    glue.agm.subscribe('T42.MarketStream.Subscribe', {
        arguments: {
            'Symbol': symbol
        },
        waitTimeoutMs: 100000
    })
        .then((stream) => {
            streams.push(stream);

            stream.onData((streamData) => {
                if (typeof callback === 'function') {
                    callback(streamData);
                }
            })
        })
        .catch(function (error) {
            console.log(error)
        })
}

const addRow = (table, rowData, emptyFlag) => {
    emptyFlag = emptyFlag || false;
    const row = document.createElement('tr');

    addRowCell(row, rowData.RIC || '');
    addRowCell(row, rowData.Description || '');
    addRowCell(row, rowData.bid || '', 'text-right');
    addRowCell(row, rowData.ask || '', 'text-right');

    row.onclick = function () {
        if (emptyFlag) {
            removeChildNodes('methodsList');
        }

        const partyMethods = glue.agm
            .methods()
            .filter((method) => method.objectTypes !== undefined && method.objectTypes.indexOf('Instrument') !== -1);

        addAvailableMethods(partyMethods, rowData.RIC, rowData.BPOD);

        row.setAttribute('data-toggle', 'modal');
        row.setAttribute('data-target', '#instruments');
    }
    row.setAttribute('id', rowData.RIC);
    table.appendChild(row);
};

const addRowCell = (row, cellData, cssClass) => {
    var cell = document.createElement('td');
    cell.innerText = cellData;

    if (cssClass) {
        cell.className = cssClass;
    }
    row.appendChild(cell);
};

const setupPortfolio = (portfolios) => {
    // Updating table with the new portfolio
    const table = document.getElementById('portfolioTable').getElementsByTagName('tbody')[0];

    // Removing all old data
    removeChildNodes('portfolioTableData');

    portfolios.forEach((item) => {
        addRow(table, item);
    });
};

const removeChildNodes = (elementId) => {
    const methodsList = document.getElementById(elementId);

    while (methodsList && methodsList.firstChild) {
        methodsList.removeChild(methodsList.firstChild);
    }
};

const updateInstruments = (streamData) => {
    const data = JSON.parse(streamData.data.data)[0];
    const symbol = data.name;
    const prices = data.image || data.update;

    if (!symbol || !prices) {
        return
    }

    const bid = prices.BID;
    const ask = prices.ASK;

    const symbolRow = document.getElementById(symbol);

    if (symbolRow !== null) {
        const symbolRows = symbolRow.getElementsByTagName('td');
        symbolRows[2].innerHTML = bid || 0;
        symbolRows[3].innerHTML = ask || 0;
    }
};

const addAvailableMethods = (methods, symbol, bpod) => {
    const methodsList = document.getElementById('methodsList');

    methods.forEach((method) => {
        const button = document.createElement('button');
        button.className = 'btn btn-default';
        button.setAttribute('type', 'button');
        button.setAttribute('data-toggle', 'tooltip');
        button.setAttribute('data-placement', 'bottom');
        button.setAttribute('title', method.displayName || method.name);
        button.textContent = method.displayName || method.name;

        button.onclick = (event) => {
            invokeAgMethodByName(method.name, {
                instrument: {
                    ric: symbol,
                    bpod: bpod
                }
            })
        }
        methodsList.appendChild(button);
    })

    // Enable tooltip
    $(function () {
        $('[data-toggle="tooltip"]').tooltip()
    })
};

const invokeAgMethodByName = (methodName, params) => {

    glue.agm.invoke(methodName, params, 'best', {}, () => {
        console.log('Method was successfully invoked')
    },
        function (error) {
            console.error(error)
        })
};

const displayResult = (result) => {
    removeChildNodes('resultInstrumentTbl');

    const resultInstrumentTbl = document.getElementById('resultInstrumentTbl');

    result.forEach((item) => {
        addTickerRow(resultInstrumentTbl, item);
    });

    $('#searchResult').modal('show');
};

const addTickerRow = (table, item) => {

    const row = document.createElement('tr');
    const portfolioTableDataTbl = document.getElementById('portfolioTableData');

    addRowCell(row, item.RIC || '');
    addRowCell(row, item.Description || '');

    row.onclick = () => {
        addRow(portfolioTableDataTbl, item);
        $('#searchResult').modal('hide');
    }

    table.appendChild(row);

    subscribeBySymbol(item.RIC, updateInstruments);
};

const getCurrentPortfolio = () => {
    const portfolio = [];
    const portfolioTableRows = document.querySelectorAll('#portfolioTableData tr');

    portfolioTableRows.forEach((row) => {
        const symbol = {};
        const tds = row.childNodes;

        tds.forEach((td, index) => {
            switch (index) {
                case 0:
                    symbol.ric = td.textContent;
                    break;
                case 1:
                    symbol.description = td.textContent;
                    break;
                case 2:
                    symbol.bid = td.textContent;
                    break;
                case 3:
                    symbol.ask = td.textContent;
                    break;
            }
        })
        portfolio.push(symbol);
    });

    return portfolio;
};

const setUpStreamIndicator = () => {

    const toggleStreamAvailable = (available) => {
        toggleStatusLabel('priceSpan', 'Price feed is', available);
    };

    glue.agm.methodAdded((method) => {
        if (method.name === StreamName && method.supportsStreaming) {
            toggleStreamAvailable(true);
        }
    });

    glue.agm.methodRemoved((method) => {
        if (method.name === StreamName && method.supportsStreaming) {
            toggleStreamAvailable(false);
        }
    });
};

const setUpGlueIndicator = () => {
    const toggleGlueAvailable = (available) => {
        toggleStatusLabel('glueSpan', 'Glue is', available);
    };

    glue.connection.connected(() => {
        toggleGlueAvailable(true);
    });

    glue.connection.disconnected(() => {
        toggleGlueAvailable(false);
    });
};

const toggleStatusLabel = (elementId, text, available) => {
    const span = document.getElementById(elementId);

    if (available) {
        span.classList.remove('label-warning');
        span.classList.add('label-success');
        span.textContent = text + ' available';
    } else {
        span.classList.remove('label-success');
        span.classList.add('label-warning');
        span.textContent = text + ' unavailable';
    }
};

const setUpWindowEventsListeners = () => {

    glue.windows.onWindowRemoved((window) => {

        const context = glue.windows.my().context;

        if (window.id === context.winId) {
            glue.windows.my().close();
        }
    });
};

const setUpTabControls = () => {
    if (glue.windows.my().mode !== 'Tab') {
        return;
    }

    const showFrameButtons = (extractTab, gatherTab) => {
        if (glue.windows.my().tabs.length >= 2) {
            glue.windows.my().addFrameButton(extractTab);
            glue.windows.my().removeFrameButton('gatherTabs');
        } else {
            glue.windows.my().addFrameButton(gatherTab);
            glue.windows.my().removeFrameButton('extractTabs');
        }
    };

    const gatherTab = {
        buttonId: 'gatherTabs',
        tooltip: 'Gather all tabs',
        order: 0,
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAIAAAAB6CAYAAAB3N1u0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAACxIAAAsSAdLdfvwAAAAYdEVYdFNvZnR3YXJlAHBhaW50Lm5ldCA0LjAuOWwzfk4AAAOlSURBVHhe7d1NaxNRFMbxfpoL7vyA+QpuXfkKVRdKdSWodKMg7tyIUIQ2xdF2TK2TmdS+kFLP5J5FkKo3sXNy5zzPD4YsPWfu35dpY7pm5eLiIhRF8XQ4HG4iX/t7ew/ae6G3xb92WbkGP4+OjuSVooHeHt9k0XB+fn4n7kxz/AcgS4azs7NHcV/6je8AZMFwfHz8LO5Kl/AbgCwXJpPJq7gn/YHPAGSxMB6P38Ud6S/8BSBLhaqqPsb96B98BSALtb/zv8bdKIGPAGSR2TO+POLXs7Wu0Liqdna2t9/05arr+ruOnqL/AcgS7eHfnq3TjV7dpHK/vK9zp+h3ALJAmE6nD+MunWEAOZLhw8nJyUbco1MMIDcyeJC/71/EHTrHAHIiQwf5h87bOL8JBpALGbh9xv8QZzfDAHIgw7bP+LtxblMMYJVkyNkzftM0P2Yj22MAqyIDdv2Mn4IBrIIM1z7jr8c5V4oBWJPBwunp6ZM448oxAEsyVPuM/zzOlwUGYEUGap/xX8fZssEALMgwYVxV7+NcWWEAFuTwt3Wo3DAACzpQjhiABR0oRwzAgg6UIwZgQQfKEQOwoAPliAFY0IFyxAAs6EA5YgAWdKAcMQALOlCOGIAFHSgrk6ap5KVXn6KBEMAtuQZGV+8+QmU0Gt2VuVP1MoBe/ZFsTe7P7C10iVc+gcswqRiAR3q4KRiAR3q4KRiAR3q4KRiAR3q4KRiAR3q4KRiAR3q4KRiAR3q4KRiAR3q4KRiAR3q4KRiAR3q4KRiAR3q4KRjAnIODg2uHh4c3r/KaTCY35D7bfp8gnm0SBjBnNBp19d/nbe+z/qIpGMAcBgCOAYBjAOAYADgGAI4BgGMA4BgAOAYAjgGAYwDgGAA4BgCOAYBjAOAYADgGAI4BgGMA4BgAOAYAjgGAYwDgGEBmZL5FPqXrv6+maTbltQuWH8c3cBGAzNb+bONPcUxahJcA2pppCQwAHAMAxwDAMQBwDAAcAwDHAMAxAHAMABwDAMcAwDEAcAwAHAMAxwDAMQBwDACclwBCXdf7cUxahIsAWjIf3xS6xOUmAGt8Wzg4BgCOAYBjAOAYADgGAI4BgGMA4BgAOAYAjgGAYwDgGAA4BgAOMQDT71MbXwv/yHbEANz6Vpb39HYkYwCOFJ+LDb0dyRiAIwwAHAMAxwDAMQBwDAAcAwD3pSge6+1I5imAy74yhnYt/JXAra2t67vD3ZdXeZVlub7MLMtbW/sFpubVd+W6GFMAAAAASUVORK5CYII='
    };

    const extractTab = {
        buttonId: 'extractTabs',
        tooltip: 'Extract all tabs',
        order: 0,
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAIAAAABjCAYAAABT7gjnAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyZpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMDY3IDc5LjE1Nzc0NywgMjAxNS8wMy8zMC0yMzo0MDo0MiAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTUgKFdpbmRvd3MpIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjM2NDE2QTIxQTkyODExRTY4QUY2RTYzRjNEM0ZFRTJBIiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOjM2NDE2QTIyQTkyODExRTY4QUY2RTYzRjNEM0ZFRTJBIj4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6MzY0MTZBMUZBOTI4MTFFNjhBRjZFNjNGM0QzRkVFMkEiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6MzY0MTZBMjBBOTI4MTFFNjhBRjZFNjNGM0QzRkVFMkEiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz7pl9TZAAAEm0lEQVR42uydW08aQRiGnXHDIRViaClNuCgJralpjIXEi/4B/7fXpmurpiSgiRdthdBKcQ2nwk4HgxWJWA6z7Hwz73vljbvMvM93GlaXCSHWIOW621Sm+wfl8CoA9++jSozBAACQEQAAIAAA1kMgAAAkAAAkAAAUekkAAJZnAwBgOQQAwPKSAAAszwYAwHIIAIDlJQEAWJ4NAIDlEDiTN/E8r3RxcdHpdrtRnQC5urqq7e/vf5Q/RgGBuucM2N1X19L4r61WK5/JZCK6rVqa39/Y2PgeiURyJFwSwmdSAd9GyfVvI7xer7uJRGJbR/Nd1/2eSqX6VMynVhLYYDD4xTlP6bjCk5OTo52dnSI1U4ZPBK0gAyjJBkxo+lBgrVY7khmpqFu0jfZrxf4GB4F2APi+v9br9c5jsdgbHczW0WmVEGg1BjYajb7c81oI5ouR3/6D3aRl/r91kARAjp7tzc3N9vr6+qvVNuz3phM0fOkGUQsAzs/Pb3K53DDdJlcYJcIw0xeCIHQAyuWyl8/nhwdSz3RLj4ZAILRtAmXab8nIH0IYpzAzExfTCoBqtfpHjnk9mYE3YHx4EIQCwHDUk/rJOU/D/HBBcOb9zWazOXAc52yZu8fj8ecBmi9G8ztsfjo42EIAdDqdgUzd73TufBncnxkCbtiCoDn3jMN8u8VhvoVhf9/3ky8BMH+BPRv1SIx6BoD5CrI+h/l2zv+UAYD589X7Jx8k5YQXBM0S8uy2z5t6LuJQ8x9nPMulfMoZAJGvIOWTBQCpX03Kp1oCQkv9I+7E2AazWWAN6fuIue/pEIn+tSD3887kCdPYyPBFLulTMJ8KAMqjfyJCyX55OLaOhRdgzV8Hj7cQY3WS9Egxb72nCIBQESVjYU7e9GVTvjUZYMx4borp84541HuApaJ/ZLyJI55ScQK0L5IaTTwuDGRNumaARTt/U8+JA1sXxybZU++NA2BVm0R1xKNaAsSs5pvY6K0aaE418k0zP6xsxjXciFnMR8o3FID/dv/Lnn2jgaVfAmC+qQDMcPiDI13DpwBmQ+Tr1MByzTZmWrSYlPa1WotOAIgnmj6kfEtKgJGpX+czC90zgAmpX+s1aAPAIwMAIxzxjMoaHA03DY2erVOAiSMfAIAAwCwtQKFQ6CL6Z9LAOABkA9g8ODjowfyn1ev1LlzXrRoHgOz/oslkMgqLp2v4XqdIJPI6m82+MLEEDP9ZNACYouPj48/pdLpg9BgIPaquTPn1YrGYNf4cAHoo3/drl5eXIkjzMQZqKs/zTjnnL2W9D7wsAgDNVC6XPyUSife2nQNAcr4/PDysbG1trfRdiegBNJAQ4nelUrnZ29tb+bsSAUDI6nQ6ZxKApIz8UA7BAEDIaT8Wi4VahtEDhDzthf0BAIDlAgAAAAIAEACA7NTcY2Amk4mUSqUGtk6Jbra3tzdJATBU2B8aQgmAAAAEACAAAAEAq6T6zTkAgJiur687AMBieZ73TeX1GN7GRUv9fv+H4zhZlRkAf45FRF+kVJqPEkBIruue7u7uflB9XTZRAVAONFS73T6Lx+Nvg7j2XwEGACbouxHl2VRVAAAAAElFTkSuQmCC'
    }

    glue.windows.my().onWindowAttached((win) => {
        glue.windows.my().addFrameButton(extractTab);
        glue.windows.my().removeFrameButton('gatherTabs');
    });

    glue.windows.my().onAttached((win) => {
        glue.windows.my().addFrameButton(extractTab);
        glue.windows.my().removeFrameButton('gatherTabs');
    });

    glue.windows.my().onDetached((win) => {
        glue.windows.my().addFrameButton(gatherTab);
        glue.windows.my().removeFrameButton('extractTabs');
    });

    glue.windows.my().onWindowDetached((win) => {
        showFrameButtons(extractTab, gatherTab);
    });

    glue.windows.my().onFrameButtonClicked((buttonInfo) => {
        const clientWindowId = glue.windows.my().context.winId;
        const clientWindow = glue.windows.findById(clientWindowId);

        if (buttonInfo.buttonId === 'extractTabs') {

            glue.windows.my().tabs.forEach((w) => {
                detachedTabs.push(w.id);
                w.detachTab();
            });

            clientWindow.updateContext({ detachedTabsArr: detachedTabs })
        }

        if (buttonInfo.buttonId === 'gatherTabs') {

            const firstWindow = glue.windows.findById(clientWindow.context.detachedTabsArr[0]);
            firstWindow.snap(clientWindowId, 'right', () => {
                clientWindow.context.detachedTabsArr.forEach((id) => {
                    if (firstWindow.id === id) {
                        return;
                    }
                    firstWindow.attachTab(id);
                })
            });
        }
    });

    if (glue.windows.my().tabs.length >= 2) {
        glue.windows.my().addFrameButton(extractTab);
    }
};

const search = (event) => {
    event.preventDefault();
    var searchValue = document.getElementById('ticker').value;
    _query.search(searchValue)
};

const sendPortfolioAsEmailClicked = (event) => {
    event.preventDefault();

    const sendPortfolioAsEmail = (client, portfolio) => {

        const getEmailContent = (client, portfolio) => {

            const props = ['ric', 'description', 'bid', 'ask']

            const csv = props.join(", ") + "\n" +
                portfolio.map((row) => {
                    return props.map((prop, index) => {
                        let value = row[prop];

                        if (index === 1) // description
                        {
                            value = '"' + value + '"'
                        }

                        return value;
                    }).join(", ")
                }).join("\n");

            const html = "<html>\n<body>\n<table>\n<tr><th>" + props.join("</th><th>") + "</th></tr>" +
                portfolio.map((row) => {
                    return "<tr><td>" + props.map((prop) => {
                        const value = row[prop];
                        return value;
                    }).join("</td><td>") + "</td></tr>"
                }).join("\n") + "\n</table>\n</body>\</html>\n";

            const fileName = 'client-' + client.eciId + '-portfolio.csv';

            const file = {
                fileName: fileName,
                data: csv,
            };

            const newEmail = {
                to: 'john.doe@domain.com',
                subject: 'Hey John, look at ' + client.name + '\'s portfolio',
                bodyHtml: html,
                attachments: [file]
            };

            return newEmail;
        };

        const content = getEmailContent(client, portfolio);

        outlook.newEmail(content)
            .then((arg) => {
                console.log('send');
            })
            .catch(function (e) {
                console.error(e)
            });
    }

    var portfolio = getCurrentPortfolio();

    sendPortfolioAsEmail(partyObj, portfolio);
};

const sendPortfolioToExcelClicked = (event) => {
    event.preventDefault();

    const sendPortfolioToExcel = (client, portfolio) => {

        const fields = ['ric', 'description', 'bid', 'ask'];

        const config = {
            columnConfig: [{
                fieldName: 'ric',
                header: 'RIC'
            }, {
                fieldName: 'description',
                header: 'Description'
            }, {
                fieldName: 'bid',
                header: 'Bid Price'
            }, {
                fieldName: 'ask',
                header: 'Ask Price'
            }],
            data: portfolio,
            options: {
                worksheet: client.name,
                workbook: 'ExportedPortfolios'
            }
        }

        const loadPortfolioFromExcel = (portfolio) => {

            unsubscribeSymbolPrices();

            removeChildNodes('portfolioTableData');
            const table = document.getElementById('portfolioTable').getElementsByTagName('tbody')[0];

            portfolio.forEach((item) => {
                item.RIC = item.ric;
                item.Description = item.description;
                addRow(table, item);
            })

            subscribeSymbolPrices();
        };

        excel.openSheet(config)
            .then((sheet) => {
                sheet.onChanged((newPortfolio) => {
                    loadPortfolioFromExcel(newPortfolio);
                })
            })
            .catch((err) => {
                console.log(err);
            });
    };

    const portfolio = getCurrentPortfolio();

    sendPortfolioToExcel(partyObj, portfolio);
};

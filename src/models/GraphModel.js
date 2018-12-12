import _ from '../lodash-custom-bundle';
import utils from '../utils';

class GraphModel {
    constructor (configuration) {

        this.config = configuration;
        this.graphData = [];
        // After getting data, set this to a promise that fetches annotations with the api
        // The graphs can then use afterAnnotations to add a callback
        this.annotationPromise = null;

        this.breakdowns = utils.cloneDeep(this.config.breakdowns || []);
        // insert a "total" breakdown as a default breakdown
        this.breakdowns.splice(0, 0, {
            total: true,
            name: 'Total',
            // this undefined is meaningful as a second parameter to DimensionalData.breakdown
            breakdownName: null,
            values: [
                { name: 'total', on: true, key: 'total' },
            ],
        })
        this.activeBreakdown = this.breakdowns[0];

        // Unless we are modifying the dataset (i.e. with a cumulative metric),
        // datasetFunction returns the same data it's passed.
        this.datasetFunction = arg => arg;

        if (this.config.cumulative) {
            this.datasetFunction = GraphModel.ACCUMULATE;
        }

        // TODO: maybe make this dynamic when the breakdown is activated?
        // Remove dimension values that have no data.
        /*
        this.breakdowns.forEach(breakdown => {
            const dimensionValues = this.data.getDimensionValues(breakdown.breakdownName);
            breakdown.values = _.filter(breakdown.values, item => dimensionValues.includes(item.key));
        });
        */
    }

    setData (data) {
        this.data = data;

        const xAxisValue = 'timestamp';
        const yAxisValue = this.config.value;


        if (this.config.structure === 'top') {
            this.graphData = topXByY(this.data, this.config).map(row => {

                row.total = {
                    total: row[yAxisValue]
                };
                row.month = utils.createDate(row.timestamp);

                delete row[yAxisValue];
                return row;
            });
            return;
        } else {
            this.data.measure(xAxisValue);
            const rawValues = this.datasetFunction(
                this.data.breakdown(yAxisValue, this.activeBreakdown.breakdownName)
            );
            this.graphData = rawValues.map((row) => {
                var ts = row.timestamp;
                const month = utils.createDate(ts);
                return {month: month, total: row[yAxisValue]};
            });

        }

    }

    /** Data for downloading as csv needs to be a flat key/value pair object **/
    downloadData(){
        let jsonData = JSON.parse(JSON.stringify(this.graphData));
        // data is an array of objects that might be deeply nested (with more than 1 level)
        let flatJSONData = []
        _.forEach(jsonData, function(item){
            flatJSONData.push(flatten(item));
        });
        return flatJSONData;
    }

    get area () {
        return this.config.area;
    }
    get darkColor () {
        return this.config.darkColor;
    }

    getAggregateLabel () {
        return this.config.additive ? 'Total' : 'Average';
    }

    getAggregate () {
        return this.getLimitedAggregate();
    }

    getDefaultBreakdown () {
        // The default breakdown is always index 0 (see constructor)
        return this.breakdowns[0];
    }
    getLimitedAggregate (limitToLastN) {
        const values = this.getAggregatedValues(limitToLastN);
        const total = _.sum(values);
        const average = _.round(total / values.length, 1);

        return this.config.additive ? total : average;
    }

    getAggregatedValues (limitToLastN) {
        const activeDict = this.getActiveBreakdownValues();
        const values = this.graphData.map((d) => {
            return _.sum(_.map(d.total, (breakdownValue, key) => {
                return key in activeDict ? breakdownValue : 0;
            }));
        });
        const limit = Math.min(limitToLastN || values.length, values.length);
        return _.takeRight(values, limit);
    }

    getChangeOverRange () {
        const data = this.getAggregatedValues();
        if (data[0] == 0 || data.length == 0) return null;
        return ((data[data.length - 1] - data[0]) / data[0] * 100).toFixed(2);
    }

    getActiveBreakdownValues () {
        const actives = this.activeBreakdown.values.filter(bv => bv.on).map(bv => bv.key);
        return actives.reduce((r, a) => { r[a] = true; return r; }, {});
    }

    activateBreakdownIfAvailable (breakdown) {
        const found = _.find(this.breakdowns, b => b.breakdownName === breakdown.breakdownName);
        if (found) {
            found.values.forEach(bv => {
                const foundValue = _.find(breakdown.values, x => x.key === bv.key);
                bv.on = foundValue ? foundValue.on : false;
            });
            this.activeBreakdown = found;
        }
    }

    getMinMax () {
        const activeDict = this.getActiveBreakdownValues();
        if (this.config.structure === 'top') {
            const sorted = _.sortBy(this.graphData, row => row.rank);
            return {
                min: sorted[sorted.length - 1].total.total,
                max: sorted[0].total.total
            }
        }

        let min = 0;
        let max = 0;

        _.forEach(this.graphData, d => {
            const active = _.toPairs(d.total).filter(r => r[0] in activeDict).map(r => r[1]);
            min = Math.min(min, _.min(active));
            max = Math.max(max, _.max(active));
        });

        return { min, max };
    }

    afterAnnotations (callback) {
        if (this.annotationPromise) {
            this.annotationPromise.then(callback);
        }
    }

    static ACCUMULATE (rawValues) {
        return rawValues.reduce((p, c) => {
            const valueName = Object.keys(rawValues[0]).filter(key => key != 'timestamp')[0];
            const newValue = {
                timestamp: c.timestamp
            }
            newValue[valueName] = {};
            const splits = rawValues[0][valueName];
            for (const split in splits) {
                const lastValue = p[p.length - 1];
                if (lastValue) {
                    newValue[valueName][split] = lastValue[valueName][split] + c[valueName][split];
                } else {
                    newValue[valueName][split] = c[valueName][split];
                }
            }
            p.push(newValue);
            return p;
        }, []);
    }
}


/**
* Stateless function that pivots the data
**/
function topXByY (data, config) {
        const x = config.key;
        const y = config.value;
        data.measure(x);
        const results = data.breakdown(y);
        return _.take(_.sortBy(results, (row) => row[y]).reverse(), results.length);
}
/**
* Convert an nested object in a set of flat key value pairs
* {some: { a:1, b:2 }} will be converted to {some.a :1, some.b:2}
**/
function flatten(obj) {
    let accumulator = {};

    function _flatten(obj, keyPrefix) {

         _.forEach(obj, function(value, key){

            if (typeof(obj[key]) === 'object'){
                _flatten(obj[key], key);

            } else {
                !keyPrefix ? accumulator[key] = value : accumulator[keyPrefix +'.'+ key] = value;
            }
        })
    }
    _flatten(obj);
    return accumulator;
}

export default GraphModel;

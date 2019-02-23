/*
 *   Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *   Licensed under the Apache License, Version 2.0 (the "License").
 *   You may not use this file except in compliance with the License.
 *   A copy of the License is located at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   or in the "license" file accompanying this file. This file is distributed
 *   on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 *   express or implied. See the License for the specific language governing
 *   permissions and limitations under the License.
 */

import _ from 'lodash';

import { CLUSTER } from './utils/constants';
import { INDEX } from '../../utils/constants';

export default class MonitorService {
  constructor(esDriver) {
    this.esDriver = esDriver;
  }

  createMonitor = async (req, reply) => {
    try {
      const params = { body: JSON.stringify(req.payload) };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ALERTING);
      const createResponse = await callWithRequest(req, 'alerting.createMonitor', params);
      reply({ ok: true, resp: createResponse });
    } catch (err) {
      console.error('Alerting - MonitorService - createMonitor:', err);
      reply({ ok: false, resp: err.message });
    }
  };

  deleteMonitor = async (req, reply) => {
    try {
      const { id } = req.params;
      const params = { monitorId: id };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ALERTING);
      const response = await callWithRequest(req, 'alerting.deleteMonitor', params);
      reply({ ok: response.result === 'deleted' });
    } catch (err) {
      console.error('Alerting - MonitorService - deleteMonitor:', err);
      reply({ ok: false, resp: err.message });
    }
  };

  getMonitor = async (req, reply) => {
    try {
      const { id } = req.params;
      const params = { monitorId: id };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ALERTING);
      const getResponse = await callWithRequest(req, 'alerting.getMonitor', params);
      const monitor = _.get(getResponse, 'monitor', null);
      const version = _.get(getResponse, '_version', null);
      if (monitor) {
        const { callWithRequest } = this.esDriver.getCluster(CLUSTER.DATA);
        const searchResponse = await callWithRequest(req, 'search', {
          index: INDEX.ALL_ALERTS,
          body: {
            size: 0,
            query: {
              bool: {
                must: {
                  term: {
                    monitor_id: id,
                  },
                },
              },
            },
            aggs: {
              active_count: {
                terms: {
                  field: 'state',
                },
              },
              '24_hour_count': {
                date_range: {
                  field: 'start_time',
                  ranges: [{ from: 'now-24h/h' }],
                },
              },
            },
          },
        });
        const dayCount = _.get(searchResponse, 'aggregations.24_hour_count.buckets.0.doc_count', 0);
        const activeBuckets = _.get(searchResponse, 'aggregations.active_count.buckets', []);
        const activeCount = activeBuckets.reduce(
          (accu, curr) => (curr.key === 'ACTIVE' ? curr.doc_count : accu),
          0
        );
        reply({ ok: true, resp: monitor, activeCount, dayCount, version });
      } else {
        reply({ ok: false });
      }
    } catch (err) {
      console.error('Alerting - MonitorService - getMonitor:', err);
      reply({ ok: false, resp: err.message });
    }
  };

  updateMonitor = async (req, reply) => {
    try {
      const { id } = req.params;
      const { version } = req.query;
      const params = { monitorId: id, version, body: JSON.stringify(req.payload) };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ALERTING);
      const updateResponse = await callWithRequest(req, 'alerting.updateMonitor', params);
      const { _version, _id } = updateResponse;
      if (_version === parseInt(version, 10) + 1) reply({ ok: true, version: _version, id: _id });
      else reply({ ok: false });
    } catch (err) {
      console.error('Alerting - MonitorService - updateMonitor:', err);
      reply({ ok: false, resp: err.message });
    }
  };

  getMonitors = async (req, reply) => {
    try {
      const { from, size, search, sortDirection, sortField, state } = req.query;

      let must = { match_all: {} };
      if (search.trim()) {
        // This is an expensive wildcard query to match monitor names such as: "This is a long monitor name"
        // search query => "long monit"
        // This is acceptable because we will never allow more than 1,000 monitors
        must = {
          query_string: {
            default_field: 'monitor.name',
            default_operator: 'AND',
            query: `*${search
              .trim()
              .split(' ')
              .join('* *')}*`,
          },
        };
      }

      const filter = [{ term: { 'monitor.type': 'monitor' } }];
      if (state !== 'all') {
        const enabled = state === 'enabled';
        filter.push({ term: { 'monitor.enabled': enabled } });
      }

      const monitorSorts = { name: 'monitor.name.keyword' };
      const monitorSortPageData = { size: 1000 };
      if (monitorSorts[sortField]) {
        monitorSortPageData.sort = [{ [monitorSorts[sortField]]: sortDirection }];
        monitorSortPageData.size = _.defaultTo(size, 1000);
        monitorSortPageData.from = _.defaultTo(from, 0);
      }

      const params = {
        body: JSON.stringify({
          version: true,
          ...monitorSortPageData,
          query: {
            bool: {
              filter,
              must,
            },
          },
        }),
      };

      const { callWithRequest: alertingCallWithRequest } = await this.esDriver.getCluster(CLUSTER.ALERTING);
      const getResponse = await alertingCallWithRequest(req, 'alerting.getMonitors', params);

      const totalMonitors = _.get(getResponse, 'hits.total', 0);
      const monitorKeyValueTuples = _.get(getResponse, 'hits.hits', []).map(result => {
        const { _id: id, _version: version, _source: monitor } = result;
        const { name, enabled } = monitor;
        return [id, { id, version, name, enabled, monitor }];
      }, {});
      const monitorMap = new Map(monitorKeyValueTuples);
      const monitorIds = [...monitorMap.keys()];

      const aggsOrderData = {};
      const aggsSorts = {
        active: 'active',
        acknowledged: 'acknowledged',
        errors: 'errors',
        ignored: 'ignored',
        lastNotificationTime: 'last_notification_time',
      };
      if (aggsSorts[sortField]) {
        aggsOrderData.order = { [aggsSorts[sortField]]: sortDirection };
      }
      const aggsParams = {
        index: INDEX.ALL_ALERTS,
        body: {
          size: 0,
          query: { terms: { monitor_id: monitorIds } },
          aggregations: {
            uniq_monitor_ids: {
              terms: {
                field: 'monitor_id',
                ...aggsOrderData,
                size: from + size,
              },
              aggregations: {
                active: { filter: { term: { state: 'ACTIVE' } } },
                acknowledged: { filter: { term: { state: 'ACKNOWLEDGED' } } },
                errors: { filter: { term: { state: 'ERROR' } } },
                ignored: {
                  filter: {
                    bool: {
                      filter: { term: { state: 'COMPLETED' } },
                      must_not: { exists: { field: 'acknowledged_time' } },
                    },
                  },
                },
                last_notification_time: { max: { field: 'last_notification_time' } },
                latest_alert: {
                  top_hits: {
                    size: 1,
                    sort: [{ start_time: { order: 'desc' } }],
                    _source: {
                      includes: ['last_notification_time', 'trigger_name'],
                    },
                  },
                },
              },
            },
          },
        },
      };

      const { callWithRequest } = this.esDriver.getCluster(CLUSTER.DATA);
      const esAggsResponse = await callWithRequest(req, 'search', aggsParams);
      const buckets = _.get(esAggsResponse, 'aggregations.uniq_monitor_ids.buckets', []).map(
        bucket => {
          const {
            key: id,
            last_notification_time: { value: lastNotificationTime },
            ignored: { doc_count: ignored },
            acknowledged: { doc_count: acknowledged },
            active: { doc_count: active },
            errors: { doc_count: errors },
            latest_alert: {
              hits: {
                hits: [
                  {
                    _source: { trigger_name: latestAlert },
                  },
                ],
              },
            },
          } = bucket;
          const monitor = monitorMap.get(id);
          monitorMap.delete(id);
          return {
            ...monitor,
            id,
            lastNotificationTime,
            ignored,
            latestAlert,
            acknowledged,
            active,
            errors,
            currentTime: Date.now(),
          };
        }
      );

      const unusedMonitors = [...monitorMap.values()].map(monitor => ({
        ...monitor,
        lastNotificationTime: null,
        ignored: 0,
        active: 0,
        acknowledged: 0,
        errors: 0,
        latestAlert: '--',
        currentTime: Date.now(),
      }));

      let results = _.orderBy(buckets.concat(unusedMonitors), [sortField], [sortDirection]);
      // If we sorted on monitor name then we already applied from/size to the first query to limit what we're aggregating over
      // Therefore we do not need to apply from/size to this result set
      // If we sorted on aggregations, then this is our in memory pagination
      if (!monitorSorts[sortField]) {
        results = results.slice(from, from + size);
      }

      reply({
        ok: true,
        monitors: results,
        totalMonitors,
      });
    } catch (err) {
      console.error('Alerting - MonitorService - getMonitors', err);
      reply({ ok: false, resp: err.message });
    }
  };

  acknowledgeAlerts = async (req, reply) => {
    try {
      const { id } = req.params;
      const params = {
        monitorId: id,
        body: JSON.stringify(req.payload),
      };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ALERTING);
      const acknowledgeResponse = await callWithRequest(req, 'alerting.acknowledgeAlerts', params);
      reply({ ok: !acknowledgeResponse.failed.length, resp: acknowledgeResponse });
    } catch (err) {
      console.error('Alerting - MonitorService - acknowledgeAlerts:', err);
      reply({ ok: false, resp: err.message });
    }
  };

  executeMonitor = async (req, reply) => {
    try {
      const { dryrun = 'true' } = req.query;
      const params = {
        body: JSON.stringify(req.payload),
        dryrun,
      };
      const { callWithRequest } = await this.esDriver.getCluster(CLUSTER.ALERTING);
      const executeResponse = await callWithRequest(req, 'alerting.executeMonitor', params);
      reply({ ok: true, resp: executeResponse });
    } catch (err) {
      console.error('Alerting - MonitorService - executeMonitor:', err);
      reply({ ok: false, resp: err.message });
    }
  };
}

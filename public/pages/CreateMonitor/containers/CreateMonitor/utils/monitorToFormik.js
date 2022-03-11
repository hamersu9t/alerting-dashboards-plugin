/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import _ from 'lodash';
import { FORMIK_INITIAL_VALUES } from './constants';
import { SEARCH_TYPE, INPUTS_DETECTOR_ID } from '../../../../../utils/constants';

// Convert Monitor JSON to Formik values used in UI forms
export default function monitorToFormik(monitor) {
  const formikValues = _.cloneDeep(FORMIK_INITIAL_VALUES);
  if (!monitor) return formikValues;
  const {
    name,
    monitor_type,
    enabled,
    schedule: { cron: { expression: cronExpression = formikValues.cronExpression, timezone } = {} },
    inputs,
    ui_metadata: { schedule = {}, search = {} } = {},
  } = monitor;
  // Default searchType to query, because if there is no ui_metadata or search then it was created through API or overwritten by API
  // In that case we don't want to guess on the UI what selections a user made, so we will default to just showing the extraction query
  let { searchType = 'query', fieldName } = search;
  if (_.isEmpty(search) && 'uri' in inputs[0]) searchType = SEARCH_TYPE.CLUSTER_METRICS;
  const isAD = searchType === SEARCH_TYPE.AD;
  const isClusterMetrics = searchType === SEARCH_TYPE.CLUSTER_METRICS;
  return {
    /* INITIALIZE WITH DEFAULTS */
    ...formikValues,

    /* CONFIGURE MONITOR */
    name,
    disabled: !enabled,

    /* This will overwrite the fields in use by Monitor from ui_metadata */
    ...schedule,
    cronExpression,

    /* DEFINE MONITOR */
    monitor_type,
    ...search,
    searchType,
    fieldName: fieldName ? [{ label: fieldName }] : [],
    timezone: timezone ? [{ label: timezone }] : [],

    detectorId: isAD ? _.get(inputs, INPUTS_DETECTOR_ID) : undefined,
    index: !isClusterMetrics
      ? inputs[0].search.indices.map((index) => ({ label: index }))
      : FORMIK_INITIAL_VALUES.index,
    query: !isClusterMetrics ? JSON.stringify(inputs[0].search.query, null, 4) : undefined,
    uri: isClusterMetrics ? inputs[0].uri : undefined,
  };
}

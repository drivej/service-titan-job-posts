<?php
/**
 * Plugin Name:       ServiceTitan Local Job Content
 * Plugin URI:        https://github.com/drivej/service-titan-job-posts
 * Description:       Imports completed ServiceTitan jobs as reviewable, location-specific content.
 * Version:           2.0.0
 * Author:            Drive
 * License:           GPLv2 or later
 * Text Domain:       service-titan-job-post
 * Requires at least: 6.4
 * Requires PHP:      7.4
 */

if (! defined('ABSPATH')) {
    exit;
}

define('ST_SYNC_VERSION', '2.0.0');
define('ST_SYNC_PLUGIN_FILE', __FILE__);
define('ST_SYNC_PLUGIN_DIR', plugin_dir_path(__FILE__));

require_once ST_SYNC_PLUGIN_DIR . 'includes/class-activator.php';
require_once ST_SYNC_PLUGIN_DIR . 'includes/class-deactivator.php';
require_once ST_SYNC_PLUGIN_DIR . 'includes/class-permalinks.php';
require_once ST_SYNC_PLUGIN_DIR . 'includes/class-sync-blocks.php';
require_once ST_SYNC_PLUGIN_DIR . 'includes/class-sevalla-api.php';
require_once ST_SYNC_PLUGIN_DIR . 'includes/class-service-client.php';
require_once ST_SYNC_PLUGIN_DIR . 'admin/class-st-sync-admin.php';

add_action('init', ['ST_Sync_Activator', 'register_content_model']);
add_action('init', ['ST_Sync_Activator', 'maybe_upgrade'], 99);

register_activation_hook(__FILE__, ['ST_Sync_Activator', 'activate']);
register_deactivation_hook(__FILE__, ['ST_Sync_Deactivator', 'deactivate']);

if (is_admin()) {
    new ST_Sync_Admin();
}

new ST_Sync_Permalinks();
new ST_Sync_Blocks();
new ST_Sync_Sevalla_API();

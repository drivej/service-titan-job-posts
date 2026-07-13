<?php
/**
 * Remove connection settings while deliberately preserving authored job posts.
 */

if (! defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('st_sync_options');
delete_option('st_sync_version');
delete_option('st_sync_site');
delete_option('st_sync_installation_id');
delete_option('st_sync_policy_dirty');
delete_option('st_sync_pending_checkout');
delete_option('st_sync_pending_license');

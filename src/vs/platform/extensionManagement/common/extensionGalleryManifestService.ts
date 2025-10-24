/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IProductExtensionMarketplace } from '../../../base/common/product.js';
import { IProductService } from '../../product/common/productService.js';
import { ExtensionGalleryResourceType, Flag, IExtensionGalleryCompositeManifest, IExtensionGalleryManifestService, ExtensionGalleryManifestStatus, IExtensionGalleryMarketplace, ExtensionGalleryManifestResource } from './extensionGalleryManifest.js';
import { FilterType, SortBy } from './extensionManagement.js';

type ExtensionGalleryConfig = {
	readonly id: string;
	readonly displayName?: string;
	readonly serviceUrl: string;
	readonly itemUrl?: string;
	readonly publisherUrl?: string;
	readonly resourceUrlTemplate?: string;
	readonly extensionUrlTemplate?: string;
	readonly controlUrl?: string;
	readonly nlsBaseUrl?: string;
};

const FILTERING_CAPABILITIES = [
	{ name: FilterType.Tag, value: 1 },
	{ name: FilterType.ExtensionId, value: 4 },
	{ name: FilterType.Category, value: 5 },
	{ name: FilterType.ExtensionName, value: 7 },
	{ name: FilterType.Target, value: 8 },
	{ name: FilterType.Featured, value: 9 },
	{ name: FilterType.SearchText, value: 10 },
	{ name: FilterType.ExcludeWithFlags, value: 12 },
] as const;

const SORTING_CAPABILITIES = [
	{ name: SortBy.NoneOrRelevance, value: 0 },
	{ name: SortBy.LastUpdatedDate, value: 1 },
	{ name: SortBy.Title, value: 2 },
	{ name: SortBy.PublisherName, value: 3 },
	{ name: SortBy.InstallCount, value: 4 },
	{ name: SortBy.AverageRating, value: 6 },
	{ name: SortBy.PublishedDate, value: 10 },
	{ name: SortBy.WeightedRating, value: 12 },
] as const;

const FLAG_CAPABILITIES = [
	{ name: Flag.None, value: 0x0 },
	{ name: Flag.IncludeVersions, value: 0x1 },
	{ name: Flag.IncludeFiles, value: 0x2 },
	{ name: Flag.IncludeCategoryAndTags, value: 0x4 },
	{ name: Flag.IncludeSharedAccounts, value: 0x8 },
	{ name: Flag.IncludeVersionProperties, value: 0x10 },
	{ name: Flag.ExcludeNonValidated, value: 0x20 },
	{ name: Flag.IncludeInstallationTargets, value: 0x40 },
	{ name: Flag.IncludeAssetUri, value: 0x80 },
	{ name: Flag.IncludeStatistics, value: 0x100 },
	{ name: Flag.IncludeLatestVersionOnly, value: 0x200 },
	{ name: Flag.Unpublished, value: 0x1000 },
	{ name: Flag.IncludeNameConflictInfo, value: 0x8000 },
	{ name: Flag.IncludeLatestPrereleaseAndStableVersionOnly, value: 0x10000 },
] as const;

function normalizeOptional(value: string | undefined): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length ? trimmed : undefined;
}

function createResources(config: ExtensionGalleryConfig): ExtensionGalleryManifestResource[] {
	const resources: ExtensionGalleryManifestResource[] = [
		{
			id: `${config.serviceUrl}/extensionquery`,
			type: ExtensionGalleryResourceType.ExtensionQueryService
		},
		{
			id: config.extensionUrlTemplate ?? `${config.serviceUrl}/vscode/{publisher}/{name}/latest`,
			type: ExtensionGalleryResourceType.ExtensionLatestVersionUri
		},
		{
			id: `${config.serviceUrl}/publishers/{publisher}/extensions/{name}/{version}/stats?statType={statTypeName}`,
			type: ExtensionGalleryResourceType.ExtensionStatisticsUri
		},
		{
			id: `${config.serviceUrl}/itemName/{publisher}.{name}/version/{version}/statType/{statTypeValue}/vscodewebextension`,
			type: ExtensionGalleryResourceType.WebExtensionStatisticsUri
		},
	];

	if (config.publisherUrl) {
		resources.push({
			id: `${config.publisherUrl}/{publisher}`,
			type: ExtensionGalleryResourceType.PublisherViewUri
		});
	}

	if (config.itemUrl) {
		resources.push({
			id: `${config.itemUrl}?itemName={publisher}.{name}`,
			type: ExtensionGalleryResourceType.ExtensionDetailsViewUri
		});
		resources.push({
			id: `${config.itemUrl}?itemName={publisher}.{name}&ssr=false#review-details`,
			type: ExtensionGalleryResourceType.ExtensionRatingViewUri
		});
	}

	if (config.resourceUrlTemplate) {
		resources.push({
			id: config.resourceUrlTemplate,
			type: ExtensionGalleryResourceType.ExtensionResourceUri
		});
	}

	return resources;
}

function toMarketplaceManifest(config: ExtensionGalleryConfig): IExtensionGalleryMarketplace {
	const resources = createResources(config);
	const filtering = FILTERING_CAPABILITIES.map(({ name, value }) => ({ name, value }));
	const sorting = SORTING_CAPABILITIES.map(({ name, value }) => ({ name, value }));
	const flags = FLAG_CAPABILITIES.map(({ name, value }) => ({ name, value }));

	return {
		version: '1.0',
		resources,
		capabilities: {
			extensionQuery: {
				filtering,
				sorting,
				flags,
			},
			signing: {
				allPublicRepositorySigned: true,
			}
		},
		marketplaceId: config.id,
		displayName: config.displayName,
		serviceUrl: config.serviceUrl,
		itemUrl: config.itemUrl,
		publisherUrl: config.publisherUrl,
		resourceUrlTemplate: config.resourceUrlTemplate,
		extensionUrlTemplate: config.extensionUrlTemplate,
		controlUrl: config.controlUrl,
		nlsBaseUrl: config.nlsBaseUrl,
	};
}

export class ExtensionGalleryManifestService extends Disposable implements IExtensionGalleryManifestService {

	readonly _serviceBrand: undefined;
	readonly onDidChangeExtensionGalleryManifest = Event.None;
	readonly onDidChangeExtensionGalleryManifestStatus = Event.None;

	constructor(
		@IProductService protected readonly productService: IProductService,
	) {
		super();
	}

	get extensionGalleryManifestStatus(): ExtensionGalleryManifestStatus {
		return this.getConfiguredMarketplaces().length ? ExtensionGalleryManifestStatus.Available : ExtensionGalleryManifestStatus.Unavailable;
	}

	async getExtensionGalleryManifest(): Promise<IExtensionGalleryCompositeManifest | null> {
		const marketplaces = this.getConfiguredMarketplaces();
		if (!marketplaces.length) {
			return null;
		}

		return {
			marketplaces: marketplaces.map(config => toMarketplaceManifest(config))
		};
	}

	private getConfiguredMarketplaces(): ExtensionGalleryConfig[] {
		const resolved: ExtensionGalleryConfig[] = [];
		const configuredMarketplaces = this.productService.extensionsMarketplaces as readonly IProductExtensionMarketplace[] | undefined;

		if (configuredMarketplaces) {
			for (let index = 0; index < configuredMarketplaces.length; index++) {
				const marketplace = configuredMarketplaces[index];
				const serviceUrl = normalizeOptional(marketplace?.serviceUrl);
				if (!serviceUrl) {
					continue;
				}

				resolved.push({
					id: normalizeOptional(marketplace.id) ?? `marketplace-${index}`,
					displayName: normalizeOptional(marketplace.displayName),
					serviceUrl,
					itemUrl: normalizeOptional(marketplace.itemUrl),
					publisherUrl: normalizeOptional(marketplace.publisherUrl),
					resourceUrlTemplate: normalizeOptional(marketplace.resourceUrlTemplate),
					extensionUrlTemplate: normalizeOptional(marketplace.extensionUrlTemplate),
					controlUrl: normalizeOptional(marketplace.controlUrl),
					nlsBaseUrl: normalizeOptional(marketplace.nlsBaseUrl),
				});
			}
		}

		if (!resolved.length) {
			const legacy = this.productService.extensionsGallery as Partial<ExtensionGalleryConfig> | undefined;
			const serviceUrl = normalizeOptional(legacy?.serviceUrl);
			if (serviceUrl) {
				resolved.push({
					id: normalizeOptional(legacy?.id) ?? serviceUrl,
					displayName: normalizeOptional(legacy?.displayName),
					serviceUrl,
					itemUrl: normalizeOptional(legacy?.itemUrl),
					publisherUrl: normalizeOptional(legacy?.publisherUrl),
					resourceUrlTemplate: normalizeOptional(legacy?.resourceUrlTemplate),
					extensionUrlTemplate: normalizeOptional(legacy?.extensionUrlTemplate),
					controlUrl: normalizeOptional(legacy?.controlUrl),
					nlsBaseUrl: normalizeOptional(legacy?.nlsBaseUrl),
				});
			}
		}

		return resolved;
	}
}
